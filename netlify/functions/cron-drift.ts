import type { Config } from "@netlify/functions";
import { handleScheduled } from "../../worker/index";
import { runtimeEnv } from "../../worker/runtime";

/** 드리프트 점검 (SPEC §10.3). 일정은 worker/cron/index.ts CRON_SCHEDULES. 같아야 한다(UTC). */
export default async () => {
  await handleScheduled("drift", runtimeEnv());
};

export const config: Config = {
  schedule: "30 18 * * 0",
};
