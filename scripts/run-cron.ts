/**
 * 예약 작업을 한 번 실행한다. 예: `pnpm run cron health`
 * Netlify 예약 함수(netlify/functions/cron-*.ts)와 같은 handleScheduled를 호출한다.
 * 원격 DB에는 `--remote`가 필요하다. DNS_DRY_RUN=false이면 실제 DNS도 바뀔 수 있다.
 */
import { CRON_SCHEDULES, type CronJob } from "../worker/cron";
import { handleScheduled } from "../worker/index";
import { envFromProcess } from "../worker/runtime";
import { loadDotEnv, openScriptDatabase } from "./local-env";

loadDotEnv();
const job = process.argv[2];
if (!job || !(job in CRON_SCHEDULES)) {
  console.error(`사용법: pnpm run cron <${Object.keys(CRON_SCHEDULES).join("|")}>`);
  process.exit(1);
}
// 원격 여부만 먼저 확인한다.
await openScriptDatabase("cron").close();

const env = envFromProcess();
try {
  await handleScheduled(job as CronJob, env);
} finally {
  await env.DB.close();
}
