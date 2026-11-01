/**
 * Netlify Functions(Node)에서 쓰는 실행 환경. 함수 인스턴스마다 한 번 만들어 재사용한다.
 *
 * 비밀이 아닌 기본값은 DEFAULT_VARS로 저장소에 둔다(예전 wrangler.jsonc vars).
 * Netlify 환경 변수(운영)나 .env(로컬)에 같은 이름이 있으면 그 값이 우선한다.
 * 비밀 값(IDP_CLIENT_SECRET, CF_API_TOKEN, DB_CONNECTION_STRING)은 기본값을 두지 않는다.
 */
import { openDatabase } from "./db";
import { VAR_NAMES, type Env, type VarName } from "./env";

export const DEFAULT_VARS: Partial<Record<VarName, string>> = {
  APP_ORIGIN: "https://domain.b-cube.kr",
  ZONE_NAME: "b-cube.kr",
  // 사용자 제공 값으로 채운다(Netlify 환경 변수로 넣어도 된다).
  CF_ZONE_ID: "",
  IDP_ISSUER: "https://id.b-cube.kr",
  IDP_CLIENT_ID: "dyn-8919b43990d5418f9047",
  ALLOWED_EMAIL_DOMAIN: "ajou.ac.kr",
  REQUIRED_SOHAKOE: "B-cube",
  ADMIN_EMAILS: "",
  MAX_LEASES_PER_USER: "3",
  LEASE_DAYS: "180",
  RENEW_WINDOW_DAYS: "30",
  NAME_HOLD_DAYS: "30",
  HEALTH_GRACE_DAYS: "3",
  HEALTH_FAIL_THRESHOLD: "7",
  EXTRA_RESERVED_NAMES: "",
  DNS_DRY_RUN: "false",
  DEV_AUTH_DEBUG: "false",
  DEV_FAKE_LOGIN: "false",
};

export function envFromProcess(source: Record<string, string | undefined> = process.env): Env {
  const vars: Partial<Record<VarName, string>> = { ...DEFAULT_VARS };
  for (const name of VAR_NAMES) {
    const value = source[name];
    if (value !== undefined) vars[name] = value;
  }
  // 값이 없으면 parseConfig가 설정 오류로 막는다. 연결은 첫 쿼리 때 맺는다.
  return { ...vars, DB: openDatabase(vars.DB_CONNECTION_STRING ?? "", vars.DB_NAME ?? "") };
}

let cached: Env | undefined;

export function runtimeEnv(): Env {
  cached ??= envFromProcess();
  return cached;
}
