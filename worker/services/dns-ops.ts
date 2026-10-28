/**
 * DNS 작업 기록 (intent log, SPEC §8).
 *
 * Cloudflare 호출과 D1 반영은 한 트랜잭션으로 묶을 수 없다. 그래서 작업 시작 전에 `dns_ops` 행을 쓰고,
 * DB 반영과 같은 batch에서 지운다. 행이 남아 있으면 중간에 실패했거나 Worker가 끊긴 작업이다.
 * 매시 cron이 남은 행의 lease를 DB 기준 상태로 맞춘다(services/repair.ts).
 *
 * `cf_ids`에는 이 작업이 만든 레코드 id를 만든 직후 기록한다. DB records에 아직 없는 레코드라도
 * 이 앱이 만들었다는 근거가 DB에 남으므로 복구에서 지울 수 있다(SPEC §0-4).
 */
export type DnsOpKind = "create" | "replace" | "reactivate" | "release" | "revoke" | "expire" | "suspend" | "repair";

/** 이 시간보다 오래된 행만 cron이 복구한다. 진행 중인 작업과 겹치지 않게 한다. */
export const OP_STALE_MS = 10 * 60_000;
/** 복구 시도 상한. 넘으면 관리자 드리프트 탭에 남겨 둔다. */
export const OP_MAX_ATTEMPTS = 5;

export interface DnsOpRow {
  id: string;
  lease_id: string;
  kind: DnsOpKind;
  cf_ids: string;
  started_at: number;
  attempts: number;
  last_error: string | null;
}

export class DnsOp {
  constructor(
    private readonly db: D1Database,
    readonly id: string,
  ) {}

  /** Cloudflare에 만든 레코드 id를 바로 기록한다. */
  async track(cfId: string): Promise<void> {
    await this.db.prepare(`UPDATE dns_ops SET cf_ids = json_insert(cf_ids, '$[#]', ?) WHERE id = ?`).bind(cfId, this.id).run();
  }

  /** 기록할 id 목록을 바꾸는 문장. DB 반영 batch에 넣는다. */
  setIdsStatement(cfIds: readonly string[]): D1PreparedStatement {
    return this.db.prepare(`UPDATE dns_ops SET cf_ids = ? WHERE id = ?`).bind(JSON.stringify(cfIds), this.id);
  }

  /** 작업 완료 문장. DB 반영 batch에 넣으면 반영과 기록 삭제가 함께 일어난다. */
  finishStatement(): D1PreparedStatement {
    return this.db.prepare(`DELETE FROM dns_ops WHERE id = ?`).bind(this.id);
  }

  async finish(): Promise<void> {
    await this.finishStatement().run();
  }
}

export async function beginOp(db: D1Database, leaseId: string, kind: DnsOpKind, now = Date.now()): Promise<DnsOp> {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO dns_ops (id, lease_id, kind, started_at) VALUES (?, ?, ?, ?)`).bind(id, leaseId, kind, now).run();
  return new DnsOp(db, id);
}

/** lease에 남은 작업이 없을 때만 복구 작업을 예약한다. 예약했으면 true. */
export async function queueRepair(db: D1Database, leaseId: string, now = Date.now()): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO dns_ops (id, lease_id, kind, started_at)
       SELECT ?, ?, 'repair', ? WHERE NOT EXISTS (SELECT 1 FROM dns_ops WHERE lease_id = ?)`,
    )
    .bind(crypto.randomUUID(), leaseId, now, leaseId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export function parseCfIds(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
