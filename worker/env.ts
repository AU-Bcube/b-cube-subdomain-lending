/**
 * 환경 변수 파싱과 검증 (SPEC §4).
 *
 * - 개발 모드(APP_ORIGIN이 http://localhost:*)에서는 필수 조건을 완화한다.
 * - 운영 주소인데 개발용 플래그가 켜져 있으면 UnsafeConfigError를 던지고, fetch 핸들러는 모든 요청에 500을 반환한다.
 */

export type AppEnv = Env;

export interface Config {
  appOrigin: string;
  isDev: boolean;
  zoneName: string;
  cfZoneId: string;
  cfApiToken: string;
  idpIssuer: string;
  idpClientId: string;
  idpClientSecret: string;
  /** IdP 클라이언트가 설정되어 있는지. 개발 모드 + DEV_FAKE_LOGIN이면 false일 수 있다. */
  oauthConfigured: boolean;
  allowedEmailDomain: string;
  /** 로그인에 필요한 소학회 이름(소문자 정규화). ADMIN_EMAILS는 면제한다. */
  requiredSohakoe: string;
  adminEmails: ReadonlySet<string>;
  maxLeasesPerUser: number;
  leaseDays: number;
  renewWindowDays: number;
  nameHoldDays: number;
  healthGraceDays: number;
  healthFailThreshold: number;
  extraReservedNames: readonly string[];
  dnsDryRun: boolean;
  devAuthDebug: boolean;
  devFakeLogin: boolean;
}

/** 개발 모드에서 ADMIN_EMAILS에 자동으로 포함되는 페르소나 (SPEC §4.2) */
export const DEV_ADMIN_EMAIL = "admin@ajou.ac.kr";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** 운영 주소에서 개발용 플래그가 켜진 경우 */
export class UnsafeConfigError extends ConfigError {
  override name = "UnsafeConfigError";
}

const LOCALHOST_ORIGIN = /^http:\/\/localhost(?::\d{1,5})?$/;

export function isLocalhostOrigin(origin: string): boolean {
  return LOCALHOST_ORIGIN.test(origin);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(name: string, value: unknown, errors: string[]): boolean {
  const v = str(value).toLowerCase();
  if (v === "" || v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  errors.push(`${name}는 true/false 중 하나여야 합니다 (현재: "${str(value)}")`);
  return false;
}

function int(name: string, value: unknown, errors: string[], min = 1): number {
  const v = str(value);
  const n = Number(v);
  if (v === "" || !Number.isInteger(n) || n < min) {
    errors.push(`${name}는 ${min} 이상의 정수여야 합니다 (현재: "${v}")`);
    return min;
  }
  return n;
}

export function splitList(value: unknown): string[] {
  return str(value)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function parseConfig(env: AppEnv): Config {
  const errors: string[] = [];
  const raw = env as unknown as Record<string, unknown>;

  const appOrigin = str(raw.APP_ORIGIN).replace(/\/+$/, "");
  if (!appOrigin) throw new ConfigError("APP_ORIGIN이 설정되지 않았습니다");
  const isDev = isLocalhostOrigin(appOrigin);

  const dnsDryRun = bool("DNS_DRY_RUN", raw.DNS_DRY_RUN, errors);
  const devAuthDebug = bool("DEV_AUTH_DEBUG", raw.DEV_AUTH_DEBUG, errors);
  const devFakeLogin = bool("DEV_FAKE_LOGIN", raw.DEV_FAKE_LOGIN, errors);

  if (!isDev) {
    // 안전장치: 운영 배포 실수 방지
    const unsafe = [
      devFakeLogin && "DEV_FAKE_LOGIN",
      devAuthDebug && "DEV_AUTH_DEBUG",
      dnsDryRun && "DNS_DRY_RUN",
    ].filter(Boolean);
    if (unsafe.length > 0) {
      throw new UnsafeConfigError(
        `APP_ORIGIN(${appOrigin})이 localhost가 아닌데 개발용 플래그가 켜져 있습니다: ${unsafe.join(", ")}`,
      );
    }
    if (!appOrigin.startsWith("https://")) errors.push("운영 APP_ORIGIN은 https://로 시작해야 합니다");
  }

  const idpIssuer = str(raw.IDP_ISSUER).replace(/\/+$/, "");
  const idpClientId = str(raw.IDP_CLIENT_ID);
  const idpClientSecret = str(raw.IDP_CLIENT_SECRET);
  const oauthConfigured = idpIssuer !== "" && idpClientId !== "" && idpClientSecret !== "";
  if (!oauthConfigured && !(isDev && devFakeLogin)) {
    errors.push("IDP_ISSUER, IDP_CLIENT_ID, IDP_CLIENT_SECRET이 필요합니다");
  }
  if (idpIssuer && !isDev && !idpIssuer.startsWith("https://")) errors.push("운영 IDP_ISSUER는 https://로 시작해야 합니다");

  const cfZoneId = str(raw.CF_ZONE_ID);
  const cfApiToken = str(raw.CF_API_TOKEN);
  if ((!cfZoneId || !cfApiToken) && !(isDev && dnsDryRun)) {
    errors.push("CF_ZONE_ID와 CF_API_TOKEN이 필요합니다");
  }

  const zoneName = str(raw.ZONE_NAME).toLowerCase();
  if (!zoneName) errors.push("ZONE_NAME이 필요합니다");
  const allowedEmailDomain = str(raw.ALLOWED_EMAIL_DOMAIN).toLowerCase();
  if (!allowedEmailDomain) errors.push("ALLOWED_EMAIL_DOMAIN이 필요합니다");
  const requiredSohakoe = str(raw.REQUIRED_SOHAKOE).toLowerCase();
  if (!requiredSohakoe) errors.push("REQUIRED_SOHAKOE가 필요합니다");

  const adminEmails = new Set(splitList(raw.ADMIN_EMAILS));
  // 개발 모드의 admin 페르소나 자동 포함은 여기서만 처리한다. 권한 검사 코드에는 개발용 분기가 없다.
  if (isDev && devFakeLogin) adminEmails.add(DEV_ADMIN_EMAIL);

  const config: Config = {
    appOrigin,
    isDev,
    zoneName,
    cfZoneId,
    cfApiToken,
    idpIssuer,
    idpClientId,
    idpClientSecret,
    oauthConfigured,
    allowedEmailDomain,
    requiredSohakoe,
    adminEmails,
    maxLeasesPerUser: int("MAX_LEASES_PER_USER", raw.MAX_LEASES_PER_USER, errors),
    leaseDays: int("LEASE_DAYS", raw.LEASE_DAYS, errors),
    renewWindowDays: int("RENEW_WINDOW_DAYS", raw.RENEW_WINDOW_DAYS, errors),
    nameHoldDays: int("NAME_HOLD_DAYS", raw.NAME_HOLD_DAYS, errors, 0),
    healthGraceDays: int("HEALTH_GRACE_DAYS", raw.HEALTH_GRACE_DAYS, errors, 0),
    healthFailThreshold: int("HEALTH_FAIL_THRESHOLD", raw.HEALTH_FAIL_THRESHOLD, errors),
    extraReservedNames: splitList(raw.EXTRA_RESERVED_NAMES),
    dnsDryRun,
    devAuthDebug,
    devFakeLogin,
  };

  if (errors.length > 0) {
    throw new ConfigError(`설정 오류:\n- ${errors.join("\n- ")}`);
  }
  return config;
}

const cache = new WeakMap<object, Config>();

/** env 객체 단위로 파싱 결과를 캐시한다. 실패하면 매번 다시 던진다. */
export function getConfig(env: AppEnv): Config {
  let config = cache.get(env);
  if (!config) {
    config = parseConfig(env);
    cache.set(env, config);
  }
  return config;
}
