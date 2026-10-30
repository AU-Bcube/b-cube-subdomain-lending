/**
 * Google OAuth (Authorization Code + PKCE) 클라이언트 (SPEC §6.1).
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { Config } from "../env";
import type { LoginIdentity } from "./login";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** OAuth 흐름 실패. reason은 로그용이며 사용자에게는 일반화한 메시지만 보여준다. */
export class OAuthError extends Error {
  override name = "OAuthError";
}

export function redirectUri(config: Config): string {
  return `${config.appOrigin}/auth/callback`;
}

export function buildAuthUrl(config: Config, params: { state: string; nonce: string; codeChallenge: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.googleClientId,
    redirect_uri: redirectUri(config),
    scope: "openid email profile",
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    // UI 힌트일 뿐 검증이 아니다. 실제 검증은 evaluateLogin이 한다.
    hd: config.allowedEmailDomain,
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/** 인가 코드를 토큰으로 교환하고 id_token을 돌려준다. */
export async function exchangeCode(
  config: Config,
  code: string,
  codeVerifier: string,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<string> {
  let res: Response;
  try {
    res = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: redirectUri(config),
        code_verifier: codeVerifier,
      }).toString(),
    });
  } catch (err) {
    throw new OAuthError(`token endpoint 요청 실패: ${String(err)}`);
  }
  const body = (await res.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null;
  if (!res.ok || typeof body?.id_token !== "string") {
    // 응답 본문에는 토큰이 없을 때만 error 코드가 들어 있으므로 error 필드만 남긴다.
    throw new OAuthError(`token endpoint 응답 오류: HTTP ${res.status} ${String(body?.error ?? "")}`);
  }
  return body.id_token;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function googleJwks() {
  // 키 집합은 isolate 단위로 캐시한다(jose가 kid 미스 시 재조회).
  jwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return jwks;
}

export interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
}

/** id_token 서명(JWKS)과 iss, aud, exp, nonce를 검증한다. */
export async function verifyIdToken(config: Config, idToken: string, expectedNonce: string): Promise<GoogleClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, googleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: config.googleClientId,
      algorithms: ["RS256"],
    }));
  } catch (err) {
    const code = err instanceof joseErrors.JOSEError ? err.code : String(err);
    throw new OAuthError(`id_token 검증 실패: ${code}`);
  }
  if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) {
    throw new OAuthError("id_token nonce 불일치");
  }
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new OAuthError("id_token에 sub 또는 email이 없음");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    // Google은 boolean으로 주지만, 그 외 값은 모두 미인증으로 취급한다.
    email_verified: payload.email_verified === true,
    ...(typeof payload.hd === "string" ? { hd: payload.hd } : {}),
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
  };
}

export function toIdentity(claims: GoogleClaims): LoginIdentity {
  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified,
    hd: claims.hd,
    name: claims.name,
  };
}
