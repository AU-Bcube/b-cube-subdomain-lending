/**
 * lease 단위 DNS 복구 (SPEC §8, §10.3). DB를 기준으로 Cloudflare를 맞춘다.
 *
 * - active: DB records가 원하는 상태다. Cloudflare에 없는 레코드는 다시 만들고, 내용이 다르면 DB 값으로 되돌린다.
 * - active가 아닌 상태(suspended, 종료): Cloudflare에 레코드가 없어야 한다. DB가 참조하는 레코드를 지운다.
 * - 작업 기록(dns_ops)에 남은 id 중 DB records가 참조하지 않는 것은 중간에 실패한 작업의 잔여물이므로 지운다.
 *
 * 이 앱이 만들었다는 근거(records.cf_record_id 또는 dns_ops.cf_ids)가 DB에 있는 레코드만 조작한다(SPEC §0-4).
 * comment만 같은 레코드는 건드리지 않는다.
 */
import { auditStatement } from "./audit";
import type { DnsClient } from "./cloudflare-dns";
import { OP_MAX_ATTEMPTS, OP_STALE_MS, parseCfIds, type DnsOpRow } from "./dns-ops";
import { recordMatches } from "./drift";
import { getLease, getRecordsByLease, recordSnapshot, removeFromCloudflare, rowToNormalized, toDnsData } from "./leases";

export interface RepairResult {
  leaseId: string;
  /** 작업 잔여물 또는 active가 아닌 lease의 레코드를 지운 수 */
  removed: number;
  /** Cloudflare에 없어 다시 만든 수 */
  recreated: number;
  /** 내용이 달라 DB 값으로 되돌린 수 */
  restored: number;
}

export function changedCount(r: RepairResult): number {
  return r.removed + r.recreated + r.restored;
}

export async function repairLease(
  db: D1Database,
  dns: DnsClient,
  leaseId: string,
  opCfIds: readonly string[] = [],
  now = Date.now(),
): Promise<RepairResult> {
  const result: RepairResult = { leaseId, removed: 0, recreated: 0, restored: 0 };
  const lease = await getLease(db, leaseId);
  const rows = (await getRecordsByLease(db, [leaseId])).get(leaseId) ?? [];
  const referenced = new Set(rows.flatMap((r) => (r.cf_record_id ? [r.cf_record_id] : [])));
  const removedSnapshots: unknown[] = [];

  // 1) 작업 잔여물: 기록에는 있지만 DB가 참조하지 않는 레코드. 이미 없으면(404) 성공으로 본다.
  for (const cfId of opCfIds) {
    if (referenced.has(cfId)) continue;
    await dns.remove(cfId);
    result.removed++;
  }

  if (!lease || lease.status !== "active") {
    // 2) active가 아닌 lease: DB가 참조하는 레코드를 모두 지운다(탈취 방지).
    const live = rows.filter((r) => r.cf_record_id !== null);
    await removeFromCloudflare(db, dns, live);
    result.removed += live.length;
    removedSnapshots.push(...live.map(recordSnapshot));
  } else if (!dns.dryRun) {
    // 3) active: DB 값이 기준이다. dry-run은 Cloudflare 목록이 항상 비어 있으므로 건너뛴다.
    const remote = new Map((await dns.listByLease(leaseId)).map((r) => [r.id, r]));
    for (const row of rows) {
      const cf = row.cf_record_id ? remote.get(row.cf_record_id) : undefined;
      if (!cf) {
        const cfId = await dns.create(toDnsData(rowToNormalized(row)), leaseId);
        await db.prepare(`UPDATE records SET cf_record_id = ?, updated_at = ? WHERE id = ?`).bind(cfId, now, row.id).run();
        result.recreated++;
      } else if (!recordMatches(row, cf)) {
        await dns.update(cf.id, toDnsData(rowToNormalized(row)), leaseId);
        result.restored++;
      }
    }
  }

  if (changedCount(result) > 0) {
    await auditStatement(db, {
      action: "system.dns_repair",
      actorEmail: null,
      actorRole: "system",
      leaseId,
      targetEmail: lease?.owner_email ?? null,
      detail: { status: lease?.status ?? null, ...result, removedRecords: removedSnapshots },
      at: now,
    }).run();
  }
  return result;
}

/**
 * 남은 작업 기록 복구 (매시 cron, 관리자 수동 실행).
 * OP_STALE_MS보다 오래된 행만 처리한다. 진행 중인 작업과 겹치지 않게 하기 위해서다.
 * 단, 복구 예약(`repair`)은 진행 중인 작업이 아니므로 바로 처리한다.
 * 성공하면 행을 지우고, 실패하면 시도 횟수와 오류를 남긴다.
 *
 * `retryExhausted`이면 시도 상한(OP_MAX_ATTEMPTS)을 넘은 행도 다시 시도한다(관리자가 원인을 고친 뒤 수동 실행).
 * 동시 실행 방지는 호출하는 쪽이 잠금(services/job-lock.ts)으로 한다.
 */
export async function recoverPendingOps(
  db: D1Database,
  dns: DnsClient,
  now = Date.now(),
  opts: { limit?: number; retryExhausted?: boolean } = {},
): Promise<{ recovered: number; failed: number; results: RepairResult[] }> {
  const { results: ops } = await db
    .prepare(
      `SELECT * FROM dns_ops WHERE (started_at < ? OR kind = 'repair') AND (attempts < ? OR ?)
        ORDER BY started_at LIMIT ?`,
    )
    .bind(now - OP_STALE_MS, OP_MAX_ATTEMPTS, opts.retryExhausted ? 1 : 0, opts.limit ?? 20)
    .all<DnsOpRow>();
  let recovered = 0;
  let failed = 0;
  const repaired: RepairResult[] = [];
  for (const op of ops) {
    try {
      const r = await repairLease(db, dns, op.lease_id, parseCfIds(op.cf_ids), now);
      await db.prepare(`DELETE FROM dns_ops WHERE id = ?`).bind(op.id).run();
      recovered++;
      if (changedCount(r) > 0) repaired.push(r);
    } catch (err) {
      failed++;
      console.error("[repair] 작업 기록 복구 실패", op.id, op.lease_id, err);
      await db
        .prepare(`UPDATE dns_ops SET attempts = attempts + 1, last_error = ? WHERE id = ?`)
        .bind(err instanceof Error ? err.message : String(err), op.id)
        .run();
    }
  }
  return { recovered, failed, results: repaired };
}
