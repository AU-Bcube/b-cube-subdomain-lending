/**
 * 드리프트 점검 (SPEC §10.3). 매주 `30 18 * * 0`.
 * Cloudflare의 `bcd:lease=` 레코드와 DB records(cf_record_id가 있는 행)를 비교하고, 안전한 경우만 자동 복구한다.
 * "Cloudflare에만 있음"은 자동으로 지우지 않는다.
 */
import type { DriftRepairSummary } from "../../shared/schemas";
import { NO_ID, type Database } from "../db";
import { auditStatement } from "../services/audit";
import type { DnsClient } from "../services/cloudflare-dns";
import { diffRecords } from "../services/drift";
import { acquireLock, RECOVER_LOCK, RECOVER_LOCK_MS } from "../services/job-lock";
import { changedCount, recoverPendingOps, repairLease, type RepairResult } from "../services/repair";

export { diffRecords, normalizeContent } from "../services/drift";

async function snapshot(db: Database, dns: DnsClient) {
  const cf = await dns.listManaged();
  const results = await db.records.find({ cf_record_id: { $ne: null } }, NO_ID).toArray();
  return diffRecords(cf, results);
}

/**
 * 안전한 경우만 자동 복구한다 (SPEC §10.3).
 * - 남은 작업 기록(dns_ops)
 * - DB에만 있음·내용 다름: DB 값으로 다시 만들거나 되돌린다(active가 아니면 지운다)
 * - active가 아닌 lease가 아직 참조하는 레코드: 지운다(탈취 방지)
 * "Cloudflare에만 있음"은 이 앱이 만들었다는 근거가 DB에 없으므로 보고만 한다.
 */
async function autoRepair(db: Database, dns: DnsClient, items: ReturnType<typeof diffRecords>, now: number): Promise<DriftRepairSummary> {
  const ops = await recoverPendingOps(db, dns, now);
  const targets = new Set<string>();
  for (const item of items) {
    if ((item.kind === "db_only" || item.kind === "mismatch") && item.leaseId) targets.add(item.leaseId);
  }
  const referenced = await db.records.distinct("lease_id", { cf_record_id: { $ne: null } });
  const ended = await db.leases.find({ id: { $in: referenced }, status: { $ne: "active" } }, { projection: { _id: 0, id: 1 } }).toArray();
  for (const row of ended) targets.add(row.id);

  const leases: RepairResult[] = [...ops.results];
  let failed = ops.failed;
  for (const leaseId of targets) {
    try {
      const r = await repairLease(db, dns, leaseId, [], now);
      if (changedCount(r) > 0) leases.push(r);
    } catch (err) {
      failed++;
      console.error("[cron:reconcile] 자동 복구 실패", leaseId, err);
    }
  }
  return { opsRecovered: ops.recovered, leases, failed };
}

export async function runReconcile(db: Database, dns: DnsClient, now = Date.now()): Promise<{ ok: boolean; driftCount: number }> {
  let items: ReturnType<typeof diffRecords>;
  let repaired: DriftRepairSummary | null = null;
  try {
    items = await snapshot(db, dns);
    // dry-run에서는 Cloudflare 목록이 항상 비어 있어 비교 결과가 의미 없으므로 복구하지 않는다.
    // 복구는 작업 기록 복구와 같은 잠금을 쓴다. 3분 안에 수동 복구가 있었으면 이번에는 비교 결과만 남긴다.
    if (!dns.dryRun && (await acquireLock(db, RECOVER_LOCK, "cron", RECOVER_LOCK_MS, now)).ok) {
      repaired = await autoRepair(db, dns, items, now);
      if (repaired.leases.length > 0) items = await snapshot(db, dns);
    }
  } catch (err) {
    console.error("[cron:reconcile] Cloudflare 조회 실패", err);
    await db.reconcileRuns.insertOne({
      at: now,
      ok: 0,
      drift_count: 0,
      items: [],
      error: "Cloudflare 레코드 목록을 가져오지 못했습니다.",
      repaired: null,
    });
    return { ok: false, driftCount: 0 };
  }
  const error = dns.dryRun ? "DNS_DRY_RUN: Cloudflare를 조회하지 않았습니다. 결과는 참고용입니다." : null;

  const inserted = await db.reconcileRuns.insertOne({
    at: now,
    ok: 1,
    drift_count: items.length,
    items,
    error,
    repaired: repaired && (repaired.leases.length > 0 || repaired.failed > 0) ? repaired : null,
  });
  const runId = inserted.insertedId.toHexString();
  if (items.length > 0) {
    const counts = { cf_only: 0, db_only: 0, mismatch: 0 };
    for (const item of items) counts[item.kind]++;
    await auditStatement(db, {
      action: "system.drift_detected",
      actorEmail: null,
      actorRole: "system",
      detail: { runId, count: items.length, ...counts, dryRun: dns.dryRun },
      at: now,
    }).run();
  }
  return { ok: true, driftCount: items.length };
}
