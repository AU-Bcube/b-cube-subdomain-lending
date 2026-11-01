/**
 * 테스트 실행 환경. 테스트용 MongoDB(test/global-setup.ts)에 테스트 파일마다 새 DB를 쓴다.
 * 개인 .env와 무관하게 설정을 고정한다.
 */
import { inject } from "vitest";
import { openDatabase } from "../worker/db";
import type { Env } from "../worker/env";
import { handleRequest } from "../worker/index";

const uri = inject("mongoUri");
const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;

export const env: Env = {
  DB: openDatabase(uri, name),
  DB_CONNECTION_STRING: uri,
  DB_NAME: name,
  APP_ORIGIN: "http://localhost:5173",
  ZONE_NAME: "b-cube.kr",
  ALLOWED_EMAIL_DOMAIN: "ajou.ac.kr",
  REQUIRED_SOHAKOE: "B-cube",
  MAX_LEASES_PER_USER: "3",
  LEASE_DAYS: "180",
  RENEW_WINDOW_DAYS: "30",
  NAME_HOLD_DAYS: "30",
  HEALTH_GRACE_DAYS: "3",
  HEALTH_FAIL_THRESHOLD: "7",
  EXTRA_RESERVED_NAMES: "",
  DNS_DRY_RUN: "true",
  DEV_FAKE_LOGIN: "false",
  DEV_AUTH_DEBUG: "false",
  IDP_ISSUER: "https://idp.test",
  IDP_CLIENT_ID: "test-client-id",
  IDP_CLIENT_SECRET: "test-client-secret",
  CF_ZONE_ID: "",
  CF_API_TOKEN: "",
  ADMIN_EMAILS: "t-admin@ajou.ac.kr",
};

/** 배포된 함수에 요청하는 것과 같다(handleRequest 직접 호출). */
export const SELF = {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return handleRequest(new Request(input, init), env);
  },
};
