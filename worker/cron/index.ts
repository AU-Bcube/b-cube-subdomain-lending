import type { Config } from "../env";
import { createDnsClient } from "../services/cloudflare-dns";
import { runExpiry } from "./expiry";
import { runHealthChecks } from "./health";
import { runReconcile } from "./reconcile";
import { purgeExpiredSessions } from "./sessions";

/** wrangler.jsonc triggers.crons와 같은 값 (SPEC §10) */
export const CRON_HEALTH = "17 * * * *";
export const CRON_DAILY = "0 18 * * *";
export const CRON_DRIFT = "30 18 * * SUN";

/** scheduled 핸들러: controller.cron 값으로 작업을 분기한다. */
export async function runScheduled(cron: string, env: Env, config: Config): Promise<void> {
  const db = env.DB;
  const dns = createDnsClient(config);
  switch (cron) {
    case CRON_HEALTH: {
      const r = await runHealthChecks(db, dns, config);
      console.log(`[cron:health] 검사 ${r.checked}건, 실패 ${r.failed}건, suspend ${r.suspended}건`);
      return;
    }
    case CRON_DAILY: {
      const r = await runExpiry(db, dns, config);
      const purged = await purgeExpiredSessions(db);
      console.log(`[cron:daily] 만료 ${r.expired}건(실패 ${r.failed}건), 만료 세션 ${purged}건 삭제`);
      return;
    }
    case CRON_DRIFT: {
      const r = await runReconcile(db, dns);
      console.log(`[cron:drift] ${r.ok ? `드리프트 ${r.driftCount}건` : "Cloudflare 조회 실패"}`);
      return;
    }
    default:
      console.warn("[cron] 알 수 없는 cron:", cron);
  }
}
