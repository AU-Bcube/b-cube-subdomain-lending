/**
 * lease 비즈니스 로직 (SPEC §8, §9).
 * 이 앱이 만든 레코드(DB records의 cf_record_id 또는 dns_ops에 기록된 id)만 Cloudflare에서 조작한다.
 * Cloudflare를 바꾸는 작업은 모두 dns_ops에 기록하고, DB 반영과 같은 batch에서 기록을 지운다(services/dns-ops.ts).
 */
import {
  checkName,
  checkNameHold,
  NAME_REASON_MESSAGES,
  validateRecordSet,
  type LeaseStatus,
  type NameLists,
  type NormalizedRecord,
  type RecordError,
  type RecordInput,
  type RecordType,
  type TargetKind,
} from "../../shared/rules";
import type { NameAvailability, RecordView } from "../../shared/schemas";
import { BANNED_WORDS } from "../data/banned-words";
import { RESERVED_NAMES } from "../data/reserved-names";
import type { Config } from "../env";
import { auditStatement, type AuditEntry } from "./audit";
import type { DnsClient, DnsRecordData } from "./cloudflare-dns";
import { beginOp, type DnsOp } from "./dns-ops";
import { checkHealth, defaultHealthDeps, type HealthDeps, type HealthResult, type HealthTarget } from "./health";

export interface LeaseRow {
  id: string;
  name: string;
  owner_email: string;
  target_kind: TargetKind;
  status: LeaseStatus;
  status_reason: string | null;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
  suspended_at: number | null;
  health_fail_count: number;
  last_health_check_at: number | null;
  last_health_ok_at: number | null;
  last_health_detail: string | null;
}

export interface RecordRow {
  id: string;
  lease_id: string;
  cf_record_id: string | null;
  type: RecordType;
  host: string;
  content: string;
  proxied: number;
  created_at: number;
  updated_at: number;
}

/** 상태 전환이 허용되지 않는 경우 */
export class LeaseStateError extends Error {
  override name = "LeaseStateError";
}

export const LIVE_STATUSES: readonly LeaseStatus[] = ["active", "suspended"];

export async function getLease(db: D1Database, id: string): Promise<LeaseRow | null> {
  return db.prepare(`SELECT * FROM leases WHERE id = ?`).bind(id).first<LeaseRow>();
}

/** lease id별 레코드. 생성 순서대로 정렬한다. */
export async function getRecordsByLease(db: D1Database, leaseIds: readonly string[]): Promise<Map<string, RecordRow[]>> {
  const map = new Map<string, RecordRow[]>(leaseIds.map((id) => [id, []]));
  if (leaseIds.length === 0) return map;
  const placeholders = leaseIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM records WHERE lease_id IN (${placeholders}) ORDER BY created_at, id`)
    .bind(...leaseIds)
    .all<RecordRow>();
  for (const row of results) map.get(row.lease_id)?.push(row);
  return map;
}

export function toRecordView(row: RecordRow): RecordView {
  return {
    id: row.id,
    type: row.type,
    host: row.host,
    content: row.content,
    proxied: row.proxied === 1,
    live: row.cf_record_id !== null,
  };
}

/** 감사 로그 detail에 남기는 레코드 형태 */
export function recordSnapshot(row: RecordRow) {
  return { type: row.type, host: row.host, content: row.content, proxied: row.proxied === 1 };
}

/**
 * Cloudflare에서 레코드를 지운다. 지운 레코드는 DB에서 cf_record_id를 NULL로 바꾼다.
 * 중간에 실패해도 이미 지운 레코드는 DB에 반영한 뒤 오류를 다시 던진다.
 */
export async function removeFromCloudflare(db: D1Database, dns: DnsClient, records: readonly RecordRow[]): Promise<void> {
  const removed: string[] = [];
  try {
    for (const record of records) {
      if (record.cf_record_id === null) continue;
      await dns.remove(record.cf_record_id);
      removed.push(record.id);
    }
  } finally {
    if (removed.length > 0) {
      const now = Date.now();
      await db.batch(
        removed.map((id) =>
          db.prepare(`UPDATE records SET cf_record_id = NULL, updated_at = ? WHERE id = ?`).bind(now, id),
        ),
      );
    }
  }
}

export interface Actor {
  email: string | null;
  role: AuditEntry["actorRole"];
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 강제 회수: Cloudflare 레코드 삭제 → status `revoked`. active/suspended에서만 가능하다.
 * DB records는 이력으로 남긴다(cf_record_id = NULL).
 */
export async function revokeLease(
  db: D1Database,
  dns: DnsClient,
  lease: LeaseRow,
  reason: string,
  actor: Actor,
): Promise<void> {
  if (!LIVE_STATUSES.includes(lease.status)) {
    throw new LeaseStateError(`${lease.status} 상태의 lease는 회수할 수 없습니다.`);
  }
  const records = (await getRecordsByLease(db, [lease.id])).get(lease.id) ?? [];
  const op = await beginOp(db, lease.id, "revoke");
  await removeFromCloudflare(db, dns, records);

  const now = Date.now();
  await db.batch([
    op.finishStatement(),
    db
      .prepare(
        `UPDATE leases SET status = 'revoked', status_reason = ?, ended_at = ?
          WHERE id = ? AND status IN ('active', 'suspended')`,
      )
      .bind(reason, now, lease.id),
    auditStatement(db, {
      action: "admin.revoke",
      actorEmail: actor.email,
      actorRole: actor.role,
      leaseId: lease.id,
      targetEmail: lease.owner_email,
      detail: {
        reason,
        name: lease.name,
        statusBefore: lease.status,
        removed: records.filter((r) => r.cf_record_id !== null).map(recordSnapshot),
      },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      at: now,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 사용자 lease 작업 (SPEC §7, §8, §9)
// ---------------------------------------------------------------------------

/** HTTP 상태와 오류 코드를 가진 lease 작업 오류 */
export class LeaseError extends Error {
  override name = "LeaseError";
  constructor(
    readonly status: 400 | 404 | 409 | 429,
    readonly code: string,
    message: string,
    readonly errors?: RecordError[],
  ) {
    super(message);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function fqdnOf(name: string, zone: string): string {
  return `${name}.${zone}`;
}

export function nameLists(config: Config): NameLists {
  return {
    reserved: new Set([...RESERVED_NAMES, ...config.extraReservedNames]),
    bannedWords: BANNED_WORDS,
  };
}

export async function countLiveLeases(db: D1Database, email: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM leases WHERE owner_email = ? AND status IN ('active','suspended')`)
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 이름 가용성 (SPEC §7.1). 정적 규칙 → 이름 보류/점유(DB) → Cloudflare 동적 충돌 순서로 검사한다.
 * Cloudflare 조회는 앞 단계를 모두 통과했을 때만 한다.
 */
export async function checkAvailability(
  db: D1Database,
  dns: DnsClient,
  config: Config,
  name: string,
  requesterEmail: string,
  now = Date.now(),
): Promise<NameAvailability> {
  const staticReason = checkName(name, nameLists(config));
  if (staticReason) return { available: false, reason: staticReason };

  const { results } = await db
    .prepare(`SELECT owner_email, status, ended_at FROM leases WHERE name = ?`)
    .bind(name)
    .all<{ owner_email: string; status: LeaseStatus; ended_at: number | null }>();
  const holdReason = checkNameHold(
    results.map((r) => ({ ownerEmail: r.owner_email, status: r.status, endedAt: r.ended_at })),
    requesterEmail,
    now,
    config.nameHoldDays,
  );
  if (holdReason) return { available: false, reason: holdReason };

  // 이 앱이 관리하지 않는 레코드(또는 정리되지 않은 레코드)가 이름이나 와일드카드에 있으면 거부한다.
  const fqdn = fqdnOf(name, config.zoneName);
  const existing = [...(await dns.listByName(fqdn)), ...(await dns.listByName(`*.${fqdn}`))];
  if (existing.length > 0) return { available: false, reason: "conflict" };
  return { available: true };
}

function nameErrorStatus(reason: NonNullable<NameAvailability["reason"]>): 400 | 409 {
  return reason === "invalid_format" || reason === "reserved" || reason === "banned_word" ? 400 : 409;
}

function validateOrThrow(name: string, config: Config, targetKind: TargetKind, records: RecordInput[]): NormalizedRecord[] {
  const result = validateRecordSet({ name, zone: config.zoneName, targetKind, records });
  if (!result.ok) {
    throw new LeaseError(400, "invalid_records", result.errors[0]?.message ?? "레코드가 올바르지 않습니다.", result.errors);
  }
  return result.records;
}

function sameRecord(row: RecordRow, rec: NormalizedRecord): boolean {
  return row.type === rec.type && row.host === rec.host && row.content === rec.content && (row.proxied === 1) === rec.proxied;
}

export function toDnsData(rec: { type: RecordType; host: string; content: string; proxied: boolean }): DnsRecordData {
  return { type: rec.type, name: rec.host, content: rec.content, proxied: rec.proxied };
}

export function rowToNormalized(row: RecordRow): NormalizedRecord {
  return { type: row.type, host: row.host, content: row.content, proxied: row.proxied === 1 };
}

interface AppliedRecordSet {
  /** DB에 반영할 문장 (레코드 삭제·수정·추가) */
  statements: D1PreparedStatement[];
  /** DB 반영 후 Cloudflare에서 지울 기존 레코드 */
  toRemove: RecordRow[];
  /** DB 반영이 실패했을 때 Cloudflare 변경을 되돌린다. 모두 되돌렸으면 true */
  rollback: () => Promise<boolean>;
}

/**
 * 레코드 세트 교체의 Cloudflare 단계 (SPEC §8 일관성 보장).
 * 1) 새 레코드 생성 → (호출하는 쪽) 2) DB 갱신 → 3) 기존 레코드 삭제.
 *
 * - 내용이 같은 레코드는 그대로 둔다.
 * - CNAME은 같은 host에 둘 이상 존재할 수 없어 "생성 후 삭제"가 불가능하므로 기존 레코드를 PATCH한다.
 * - 생성·수정 도중 실패하면 이미 한 변경을 되돌리고 DnsError를 다시 던진다. 모두 되돌렸으면 작업 기록도 지운다.
 * - 만든 레코드 id는 바로 작업 기록(op)에 남긴다.
 */
export async function applyRecordSet(
  db: D1Database,
  dns: DnsClient,
  leaseId: string,
  oldRows: readonly RecordRow[],
  next: readonly NormalizedRecord[],
  op: DnsOp,
  now = Date.now(),
): Promise<AppliedRecordSet> {
  const remaining = oldRows.filter((r) => r.cf_record_id !== null);
  const kept = new Set<string>();
  const plan: Array<{ kind: "create"; rec: NormalizedRecord } | { kind: "update"; rec: NormalizedRecord; old: RecordRow }> = [];

  for (const rec of next) {
    const same = remaining.find((r) => !kept.has(r.id) && sameRecord(r, rec));
    if (same) {
      kept.add(same.id);
      continue;
    }
    plan.push({ kind: "create", rec });
  }
  for (const [i, step] of plan.entries()) {
    if (step.rec.type !== "CNAME") continue;
    const old = remaining.find((r) => !kept.has(r.id) && r.type === "CNAME" && r.host === step.rec.host);
    if (old) {
      kept.add(old.id);
      plan[i] = { kind: "update", rec: step.rec, old };
    }
  }

  const created: Array<{ cfId: string; rec: NormalizedRecord }> = [];
  const updated: Array<{ old: RecordRow; rec: NormalizedRecord }> = [];
  const rollback = async () => {
    let clean = true;
    for (const c of created) {
      await dns.remove(c.cfId).catch((err) => {
        clean = false;
        console.error("[lease] 롤백: 생성한 레코드 삭제 실패", c.cfId, err);
      });
    }
    for (const u of updated) {
      await dns.update(u.old.cf_record_id!, toDnsData(rowToNormalized(u.old)), leaseId).catch((err) => {
        clean = false;
        console.error("[lease] 롤백: 수정한 레코드 복구 실패", u.old.cf_record_id, err);
      });
    }
    return clean;
  };

  try {
    for (const step of plan) {
      if (step.kind === "update") {
        await dns.update(step.old.cf_record_id!, toDnsData(step.rec), leaseId);
        updated.push({ old: step.old, rec: step.rec });
      } else {
        const cfId = await dns.create(toDnsData(step.rec), leaseId);
        created.push({ cfId, rec: step.rec });
        await op.track(cfId);
      }
    }
  } catch (err) {
    if (await rollback()) await op.finish();
    throw err;
  }

  // 유지·수정되지 않은 기존 행(cf_record_id가 없는 행 포함)은 DB에서 지운다.
  const dropped = oldRows.filter((r) => !kept.has(r.id));
  const statements: D1PreparedStatement[] = [
    ...dropped.map((r) => db.prepare(`DELETE FROM records WHERE id = ?`).bind(r.id)),
    ...updated.map((u) =>
      db
        .prepare(`UPDATE records SET content = ?, proxied = ?, updated_at = ? WHERE id = ?`)
        .bind(u.rec.content, u.rec.proxied ? 1 : 0, now, u.old.id),
    ),
    ...created.map((c, i) =>
      db
        .prepare(
          `INSERT INTO records (id, lease_id, cf_record_id, type, host, content, proxied, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), leaseId, c.cfId, c.rec.type, c.rec.host, c.rec.content, c.rec.proxied ? 1 : 0, now + i, now + i),
    ),
  ];
  return { statements, toRemove: dropped.filter((r) => r.cf_record_id !== null), rollback };
}

/**
 * DB 반영 후 기존 레코드 삭제. 실패해도 작업은 성공으로 둔다.
 * 남은 레코드는 작업 기록에 id가 있으므로 매시 cron 복구가 지운다. 모두 지웠으면 true.
 */
async function removeStale(dns: DnsClient, rows: readonly RecordRow[]): Promise<boolean> {
  let clean = true;
  for (const row of rows) {
    await dns.remove(row.cf_record_id!).catch((err) => {
      clean = false;
      console.error("[lease] 기존 레코드 삭제 실패(cron 복구 대상)", row.cf_record_id, err);
    });
  }
  return clean;
}

function auditOf(actor: Actor, entry: Omit<AuditEntry, "actorEmail" | "actorRole" | "ip" | "userAgent">): AuditEntry {
  return { ...entry, actorEmail: actor.email, actorRole: actor.role, ip: actor.ip ?? null, userAgent: actor.userAgent ?? null };
}

export async function createLease(
  db: D1Database,
  dns: DnsClient,
  config: Config,
  ownerEmail: string,
  input: { name: string; targetKind: TargetKind; records: RecordInput[] },
  actor: Actor,
): Promise<LeaseRow> {
  const name = input.name.trim().toLowerCase();
  const now = Date.now();
  if ((await countLiveLeases(db, ownerEmail)) >= config.maxLeasesPerUser) {
    throw new LeaseError(409, "limit_reached", `서브도메인은 1인당 최대 ${config.maxLeasesPerUser}개까지 사용할 수 있습니다.`);
  }
  // 레코드 형식을 먼저 검사해 Cloudflare 조회를 줄인다.
  const records = validateOrThrow(name, config, input.targetKind, input.records);
  const availability = await checkAvailability(db, dns, config, name, ownerEmail, now);
  if (!availability.available && availability.reason) {
    throw new LeaseError(nameErrorStatus(availability.reason), availability.reason, NAME_REASON_MESSAGES[availability.reason]);
  }

  const id = crypto.randomUUID();
  const lease: LeaseRow = {
    id,
    name,
    owner_email: ownerEmail,
    target_kind: input.targetKind,
    status: "active",
    status_reason: null,
    created_at: now,
    expires_at: now + config.leaseDays * DAY_MS,
    ended_at: null,
    suspended_at: null,
    health_fail_count: 0,
    last_health_check_at: null,
    last_health_ok_at: null,
    last_health_detail: null,
  };
  const op = await beginOp(db, id, "create", now);
  const applied = await applyRecordSet(db, dns, id, [], records, op, now);
  try {
    await db.batch([
      op.finishStatement(),
      db
        .prepare(
          `INSERT INTO leases (id, name, owner_email, target_kind, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(id, name, ownerEmail, input.targetKind, now, lease.expires_at),
      ...applied.statements,
      auditStatement(db, auditOf(actor, {
        action: "lease.create",
        leaseId: id,
        targetEmail: ownerEmail,
        detail: { name, targetKind: input.targetKind, after: records },
        at: now,
      })),
    ]);
  } catch (err) {
    if (await applied.rollback()) await op.finish();
    // 동시에 같은 이름이 생성된 경우 uq_leases_name_live 위반
    if (String(err).includes("UNIQUE")) throw new LeaseError(409, "taken", NAME_REASON_MESSAGES.taken);
    throw err;
  }
  return lease;
}

export async function replaceLeaseRecords(
  db: D1Database,
  dns: DnsClient,
  config: Config,
  lease: LeaseRow,
  inputRecords: RecordInput[],
  actor: Actor,
): Promise<{ changed: boolean }> {
  if (lease.status !== "active") {
    throw new LeaseStateError("사용 중(active) 상태에서만 레코드를 바꿀 수 있습니다.");
  }
  const next = validateOrThrow(lease.name, config, lease.target_kind, inputRecords);
  const oldRows = (await getRecordsByLease(db, [lease.id])).get(lease.id) ?? [];
  const now = Date.now();
  const op = await beginOp(db, lease.id, "replace", now);
  const applied = await applyRecordSet(db, dns, lease.id, oldRows, next, op, now);
  if (applied.statements.length === 0) {
    await op.finish();
    return { changed: false };
  }
  try {
    await db.batch([
      // 반영 후에는 지울 기존 레코드만 기록에 남긴다(새 레코드는 records가 참조한다).
      op.setIdsStatement(applied.toRemove.map((r) => r.cf_record_id!)),
      ...applied.statements,
      auditStatement(db, auditOf(actor, {
        action: "lease.update_records",
        leaseId: lease.id,
        targetEmail: lease.owner_email,
        detail: { before: oldRows.map(recordSnapshot), after: next },
        at: now,
      })),
    ]);
  } catch (err) {
    if (await applied.rollback()) await op.finish();
    throw err;
  }
  if (await removeStale(dns, applied.toRemove)) await op.finish();
  return { changed: true };
}

export function isRenewable(lease: Pick<LeaseRow, "status" | "expires_at">, config: Config, now = Date.now()): boolean {
  return LIVE_STATUSES.includes(lease.status) && lease.expires_at - now <= config.renewWindowDays * DAY_MS;
}

export async function renewLease(db: D1Database, config: Config, lease: LeaseRow, actor: Actor): Promise<number> {
  const now = Date.now();
  if (!isRenewable(lease, config, now)) {
    throw new LeaseError(409, "renew_not_allowed", `만료 ${config.renewWindowDays}일 이내일 때만 연장할 수 있습니다.`);
  }
  const expiresAt = now + config.leaseDays * DAY_MS;
  await db.batch([
    db.prepare(`UPDATE leases SET expires_at = ? WHERE id = ?`).bind(expiresAt, lease.id),
    auditStatement(db, auditOf(actor, {
      action: "lease.renew",
      leaseId: lease.id,
      targetEmail: lease.owner_email,
      detail: { before: { expiresAt: lease.expires_at }, after: { expiresAt } },
      at: now,
    })),
  ]);
  return expiresAt;
}

/** 반납: Cloudflare 레코드 삭제 → status `released`. DB records는 이력으로 남긴다. */
export async function releaseLease(db: D1Database, dns: DnsClient, lease: LeaseRow, actor: Actor): Promise<void> {
  if (!LIVE_STATUSES.includes(lease.status)) throw new LeaseStateError("이미 종료된 서브도메인입니다.");
  const records = (await getRecordsByLease(db, [lease.id])).get(lease.id) ?? [];
  const op = await beginOp(db, lease.id, "release");
  await removeFromCloudflare(db, dns, records);
  const now = Date.now();
  await db.batch([
    op.finishStatement(),
    db
      .prepare(`UPDATE leases SET status = 'released', status_reason = NULL, ended_at = ? WHERE id = ? AND status IN ('active','suspended')`)
      .bind(now, lease.id),
    auditStatement(db, auditOf(actor, {
      action: "lease.release",
      leaseId: lease.id,
      targetEmail: lease.owner_email,
      detail: { name: lease.name, removed: records.filter((r) => r.cf_record_id !== null).map(recordSnapshot) },
      at: now,
    })),
  ]);
}

export function healthTarget(lease: LeaseRow, records: readonly RecordRow[], zone: string): HealthTarget {
  return { targetKind: lease.target_kind, fqdn: fqdnOf(lease.name, zone), records };
}

export const RECHECK_COOLDOWN_MS = 60_000;

/**
 * 사용자 재확인 (SPEC §9, §10.2). 즉시 헬스체크를 하고,
 * suspended에서 통과하면 레코드를 다시 만들고 active로 전환한다.
 * 실패해도 실패 횟수는 올리지 않는다(누적은 cron만 한다).
 */
export async function recheckLease(
  db: D1Database,
  dns: DnsClient,
  config: Config,
  lease: LeaseRow,
  actor: Actor,
  deps: HealthDeps = defaultHealthDeps,
): Promise<{ result: HealthResult; reactivated: boolean }> {
  if (!LIVE_STATUSES.includes(lease.status)) throw new LeaseStateError("종료된 서브도메인은 재확인할 수 없습니다.");
  const now = Date.now();
  if (lease.last_health_check_at !== null && now - lease.last_health_check_at < RECHECK_COOLDOWN_MS) {
    throw new LeaseError(429, "recheck_too_soon", "잠시 후 다시 시도해 주세요. 재확인은 1분에 한 번만 할 수 있습니다.");
  }
  const records = (await getRecordsByLease(db, [lease.id])).get(lease.id) ?? [];
  const result = await checkHealth(healthTarget(lease, records, config.zoneName), lease.status === "suspended" ? "target" : "live", deps);

  const recheckAudit = auditStatement(db, auditOf(actor, {
    action: "lease.recheck",
    leaseId: lease.id,
    targetEmail: lease.owner_email,
    detail: { ok: result.ok, detail: result.detail, status: lease.status },
    at: now,
  }));
  const healthUpdate = result.ok
    ? db
        .prepare(`UPDATE leases SET last_health_check_at = ?, last_health_ok_at = ?, last_health_detail = ?, health_fail_count = 0 WHERE id = ?`)
        .bind(now, now, result.detail, lease.id)
    : db.prepare(`UPDATE leases SET last_health_check_at = ?, last_health_detail = ? WHERE id = ?`).bind(now, result.detail, lease.id);

  if (!(result.ok && lease.status === "suspended")) {
    await db.batch([healthUpdate, recheckAudit]);
    return { result, reactivated: false };
  }

  // 재활성화: 레코드 재생성 → DB 반영. 실패하면 생성한 레코드를 지운다.
  const op = await beginOp(db, lease.id, "reactivate", now);
  const created: Array<{ row: RecordRow; cfId: string }> = [];
  const undo = async () => {
    let clean = true;
    for (const c of created) {
      await dns.remove(c.cfId).catch((err) => {
        clean = false;
        console.error("[lease] 재활성화 롤백: 생성한 레코드 삭제 실패", c.cfId, err);
      });
    }
    return clean;
  };
  try {
    for (const row of records) {
      const cfId = await dns.create(toDnsData(rowToNormalized(row)), lease.id);
      created.push({ row, cfId });
      await op.track(cfId);
    }
  } catch (err) {
    const clean = await undo();
    await db.batch([healthUpdate, recheckAudit, ...(clean ? [op.finishStatement()] : [])]);
    throw err;
  }
  try {
    await db.batch([
      op.finishStatement(),
      healthUpdate,
      ...created.map((c) => db.prepare(`UPDATE records SET cf_record_id = ?, updated_at = ? WHERE id = ?`).bind(c.cfId, now, c.row.id)),
      db
        .prepare(`UPDATE leases SET status = 'active', status_reason = NULL, suspended_at = NULL WHERE id = ? AND status = 'suspended'`)
        .bind(lease.id),
      recheckAudit,
      auditStatement(db, auditOf(actor, {
        action: "lease.reactivate",
        leaseId: lease.id,
        targetEmail: lease.owner_email,
        detail: { after: records.map(recordSnapshot) },
        at: now,
      })),
    ]);
  } catch (err) {
    if (await undo()) await op.finish();
    throw err;
  }
  return { result, reactivated: true };
}

// ---------------------------------------------------------------------------
// 시스템 작업 (cron, SPEC §10)
// ---------------------------------------------------------------------------

const SYSTEM: Actor = { email: null, role: "system" };

/** 헬스체크 실패 누적으로 suspend: Cloudflare 레코드 삭제, DB records 유지(cf_record_id NULL) */
export async function suspendLease(db: D1Database, dns: DnsClient, lease: LeaseRow, failCount: number, now = Date.now()): Promise<void> {
  const records = (await getRecordsByLease(db, [lease.id])).get(lease.id) ?? [];
  const op = await beginOp(db, lease.id, "suspend", now);
  await removeFromCloudflare(db, dns, records);
  await db.batch([
    op.finishStatement(),
    db
      .prepare(
        `UPDATE leases SET status = 'suspended', status_reason = 'health_check_failed', suspended_at = ? WHERE id = ? AND status = 'active'`,
      )
      .bind(now, lease.id),
    auditStatement(db, auditOf(SYSTEM, {
      action: "system.suspend",
      leaseId: lease.id,
      targetEmail: lease.owner_email,
      detail: { reason: "health_check_failed", failCount, removed: records.filter((r) => r.cf_record_id !== null).map(recordSnapshot) },
      at: now,
    })),
  ]);
}

/** 만료: (남은) Cloudflare 레코드 삭제 → status `expired` */
export async function expireLease(db: D1Database, dns: DnsClient, lease: LeaseRow, cause: string, now = Date.now()): Promise<void> {
  const records = (await getRecordsByLease(db, [lease.id])).get(lease.id) ?? [];
  const op = await beginOp(db, lease.id, "expire", now);
  await removeFromCloudflare(db, dns, records);
  await db.batch([
    op.finishStatement(),
    db
      .prepare(`UPDATE leases SET status = 'expired', status_reason = ?, ended_at = ? WHERE id = ? AND status IN ('active','suspended')`)
      .bind(cause, now, lease.id),
    auditStatement(db, auditOf(SYSTEM, {
      action: "system.expire",
      leaseId: lease.id,
      targetEmail: lease.owner_email,
      detail: { cause, statusBefore: lease.status, removed: records.filter((r) => r.cf_record_id !== null).map(recordSnapshot) },
      at: now,
    })),
  ]);
}
