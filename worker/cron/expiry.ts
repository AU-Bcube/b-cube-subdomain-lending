/**
 * 만료 처리 (SPEC §10.1, §10.2 마지막 항목). 매일 `0 18 * * *`.
 * - active이고 expires_at < now → expired
 * - suspended이고 expires_at < now → expired (레코드는 이미 제거됨)
 * - suspended로 NAME_HOLD_DAYS가 지남 → expired
 */
import type { Config } from "../env";
import type { DnsClient } from "../services/cloudflare-dns";
import { expireLease, type LeaseRow } from "../services/leases";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 한 번 실행에서 처리하는 최대 개수 (Workers 서브요청 한도 고려). 남은 것은 다음 날 처리된다. */
export const EXPIRY_BATCH = 50;

export async function runExpiry(db: D1Database, dns: DnsClient, config: Config, now = Date.now()): Promise<{ expired: number; failed: number }> {
  const holdCutoff = now - config.nameHoldDays * DAY_MS;
  const { results } = await db
    .prepare(
      `SELECT * FROM leases
        WHERE (status = 'active' AND expires_at < ?)
           OR (status = 'suspended' AND (expires_at < ? OR suspended_at < ?))
        ORDER BY expires_at
        LIMIT ?`,
    )
    .bind(now, now, holdCutoff, EXPIRY_BATCH)
    .all<LeaseRow>();

  let expired = 0;
  let failed = 0;
  for (const lease of results) {
    const cause = lease.expires_at < now ? "lease_expired" : "suspended_too_long";
    try {
      await expireLease(db, dns, lease, cause, now);
      expired++;
    } catch (err) {
      // Cloudflare 삭제 실패 등. 상태를 바꾸지 않았으므로 다음 실행에서 다시 시도한다.
      console.error("[cron:expiry] 만료 처리 실패", lease.id, err);
      failed++;
    }
  }
  return { expired, failed };
}
