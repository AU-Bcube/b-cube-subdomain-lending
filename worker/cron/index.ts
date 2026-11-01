import type { Config, Env } from "../env";
import { createDnsClient } from "../services/cloudflare-dns";
import { acquireLock, RECOVER_LOCK, RECOVER_LOCK_MS } from "../services/job-lock";
import { recoverPendingOps } from "../services/repair";
import { runExpiry } from "./expiry";
import { runHealthChecks } from "./health";
import { runReconcile } from "./reconcile";
import { purgeExpiredSessions } from "./sessions";

/**
 * 예약 작업 일정 (SPEC §10, UTC).
 * Netlify는 함수 파일의 `config.schedule`을 정적으로 읽으므로 netlify/functions/cron-*.ts에 같은 값을 문자열로 적는다.
 * 두 곳이 같은지는 test/cron.test.ts가 확인한다.
 */
export const CRON_SCHEDULES = {
  health: "17 * * * *",
  daily: "0 18 * * *",
  drift: "30 18 * * 0",
} as const;

export type CronJob = keyof typeof CRON_SCHEDULES;

export const CRON_HEALTH = CRON_SCHEDULES.health;
export const CRON_DAILY = CRON_SCHEDULES.daily;
export const CRON_DRIFT = CRON_SCHEDULES.drift;

/** 예약 작업 실행: 작업 이름으로 분기한다. */
export async function runScheduled(job: CronJob, env: Env, config: Config): Promise<void> {
  const db = env.DB;
  const dns = createDnsClient(config);
  switch (job) {
    case "health": {
      const r = await runHealthChecks(db, dns, config);
      console.log(`[cron:health] 검사 ${r.checked}건, 실패 ${r.failed}건, suspend ${r.suspended}건`);
      // 중간에 실패했거나 끊긴 DNS 작업을 DB 기준으로 맞춘다. 관리자 수동 실행이 3분 안에 있었으면 건너뛴다.
      if (!(await acquireLock(db, RECOVER_LOCK, "cron", RECOVER_LOCK_MS)).ok) {
        console.log("[cron:ops] 최근 수동 복구가 있어 이번 실행은 건너뜁니다");
        return;
      }
      const ops = await recoverPendingOps(db, dns);
      if (ops.recovered + ops.failed > 0) console.log(`[cron:ops] 작업 기록 복구 ${ops.recovered}건, 실패 ${ops.failed}건`);
      return;
    }
    case "daily": {
      const r = await runExpiry(db, dns, config);
      const purged = await purgeExpiredSessions(db);
      console.log(`[cron:daily] 만료 ${r.expired}건(실패 ${r.failed}건), 만료 세션 ${purged}건 삭제`);
      return;
    }
    case "drift": {
      const r = await runReconcile(db, dns);
      console.log(`[cron:drift] ${r.ok ? `드리프트 ${r.driftCount}건` : "Cloudflare 조회 실패"}`);
      return;
    }
    default:
      console.warn("[cron] 알 수 없는 작업:", job satisfies never);
  }
}
