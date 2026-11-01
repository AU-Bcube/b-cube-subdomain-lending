import type { Config } from "@netlify/functions";
import { handleScheduled } from "../../worker/index";
import { runtimeEnv } from "../../worker/runtime";

/** 만료 처리 + 만료 세션 정리 (SPEC §10.1). 일정은 worker/cron/index.ts CRON_SCHEDULES. 같아야 한다(UTC). */
export default async () => {
  await handleScheduled("daily", runtimeEnv());
};

export const config: Config = {
  schedule: "0 18 * * *",
};
