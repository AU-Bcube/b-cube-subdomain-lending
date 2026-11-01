/**
 * 헬스체크 (SPEC §10.2). 매시 `17 * * * *`.
 * last_health_check_at이 가장 오래된 active lease를 최대 10개 검사한다. 24시간 이내에 검사한 lease는 건너뛴다.
 */
import { NO_ID, type Database } from "../db";
import type { Config } from "../env";
import { auditStatement } from "../services/audit";
import type { DnsClient } from "../services/cloudflare-dns";
import { checkHealth, defaultHealthDeps, type HealthDeps } from "../services/health";
import { getRecordsByLease, healthTarget, suspendLease } from "../services/leases";

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const HEALTH_BATCH = 10;

/** KST 기준 날짜 번호 (같은 날 중복 기록 방지용) */
export function kstDay(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / DAY_MS);
}

export async function runHealthChecks(
  db: Database,
  dns: DnsClient,
  config: Config,
  now = Date.now(),
  deps: HealthDeps = defaultHealthDeps,
): Promise<{ checked: number; failed: number; suspended: number }> {
  // null은 오름차순에서 먼저 온다: 한 번도 검사하지 않은 lease부터 처리한다.
  const leases = await db.leases
    .find({ status: "active", $or: [{ last_health_check_at: null }, { last_health_check_at: { $lt: now - DAY_MS } }] }, NO_ID)
    .sort({ last_health_check_at: 1 })
    .limit(HEALTH_BATCH)
    .toArray();
  const records = await getRecordsByLease(db, leases.map((l) => l.id));

  let failed = 0;
  let suspended = 0;
  for (const lease of leases) {
    const result = await checkHealth(healthTarget(lease, records.get(lease.id) ?? [], config.zoneName), "live", deps).catch(
      (err: unknown) => ({ ok: false, detail: `검사 오류: ${err instanceof Error ? err.message : String(err)}` }),
    );
    if (result.ok) {
      await db.leases.updateOne(
        { id: lease.id },
        { $set: { health_fail_count: 0, last_health_check_at: now, last_health_ok_at: now, last_health_detail: result.detail } },
      );
      continue;
    }
    failed++;

    const inGrace = now - lease.created_at < config.healthGraceDays * DAY_MS;
    // 실패 횟수는 하루(KST)에 한 번만 올린다. 마지막 실패 기록과 같은 날이면 검사 시각만 갱신한다.
    const lastFail = await db.auditLogs.findOne({ lease_id: lease.id, action: "system.health_fail" }, { sort: { at: -1 } });
    const sameDay = lastFail != null && kstDay(lastFail.at) === kstDay(now);
    const count = !inGrace && !sameDay;
    const failCount = lease.health_fail_count + (count ? 1 : 0);

    await db.batch([
      db.write((session) =>
        db.leases.updateOne(
          { id: lease.id },
          { $set: { health_fail_count: failCount, last_health_check_at: now, last_health_detail: result.detail } },
          { session },
        ),
      ),
      ...(count
        ? [
            auditStatement(db, {
              action: "system.health_fail",
              actorEmail: null,
              actorRole: "system",
              leaseId: lease.id,
              targetEmail: lease.owner_email,
              detail: { failCount, reason: result.detail },
              at: now,
            }),
          ]
        : []),
    ]);

    if (failCount >= config.healthFailThreshold) {
      try {
        await suspendLease(db, dns, lease, failCount, now);
        suspended++;
      } catch (err) {
        // 상태가 active로 남으므로 다음 검사에서 다시 시도한다.
        console.error("[cron:health] suspend 실패", lease.id, err);
      }
    }
  }
  return { checked: leases.length, failed, suspended };
}
