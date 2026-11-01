import type { Config } from "@netlify/functions";
import { handleScheduled } from "../../worker/index";
import { runtimeEnv } from "../../worker/runtime";

/** 헬스체크 (SPEC §10.2). 일정은 worker/cron/index.ts CRON_SCHEDULES. 같아야 한다(UTC). */
export default async () => {
  await handleScheduled("health", runtimeEnv());
};

export const config: Config = {
  schedule: "17 * * * *",
};
