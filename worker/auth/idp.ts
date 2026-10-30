/**
 * B-CUBE IdP(OpenID Connect, Authorization Code + PKCE) 클라이언트 (SPEC §6.1).
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { Config } from "../env";
import type { LoginIdentity, SohakoeMembership } from "./login";

export const IDP_SCOPES = "openid email profile student sohakoe";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** OAuth 흐름 실패. reason은 로그용이며 사용자에게는 일반화한 메시지만 보여준다. */
export class OAuthError extends Error {
  override name = "OAuthError";
}

export function redirectUri(config: Config): string {
  return `${config.appOrigin}/auth/callback`;
}

export function buildAuthUrl(config: Config, params: { state: string; nonce: string; codeChallenge: string }): string {
  const url = new URL(`${config.idpIssuer}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.idpClientId,
    redirect_uri: redirectUri(config),
    scope: IDP_SCOPES,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** client_secret_basic. RFC 6749 §2.3.1에 따라 각 값을 form-urlencode한 뒤 묶는다. */
function basicAuth(config: Config): string {
  const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return `Basic ${btoa(`${encode(config.idpClientId)}:${encode(config.idpClientSecret)}`)}`;
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
    res = await fetcher(`${config.idpIssuer}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: basicAuth(config),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
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

function idpJwks(config: Config) {
  // 키 집합은 isolate 단위로 캐시한다(jose가 kid 미스 시 재조회).
  jwks ??= createRemoteJWKSet(new URL(`${config.idpIssuer}/jwks.json`));
  return jwks;
}

export interface IdpClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  studentId?: string;
  sohakoeMemberships: SohakoeMembership[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 저장할 필드만 고른다. 형식이 맞지 않는 값은 없는 것으로 취급한다. */
function parseMemberships(value: unknown): SohakoeMembership[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const row = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const name = text(row.name);
    if (!name) return [];
    const optional = ["year", "semester", "from", "to"] as const;
    return [{ name, ...Object.fromEntries(optional.flatMap((k) => (text(row[k]) ? [[k, text(row[k])]] : []))) }];
  });
}

/** id_token 서명(JWKS)과 iss, aud, exp, nonce를 검증한다. */
export async function verifyIdToken(config: Config, idToken: string, expectedNonce: string): Promise<IdpClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, idpJwks(config), {
      issuer: config.idpIssuer,
      audience: config.idpClientId,
      algorithms: ["ES256"],
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
  const student = payload.student as { id?: unknown } | undefined;
  const studentId = text(student?.id);
  return {
    sub: payload.sub,
    email: payload.email,
    // boolean true가 아닌 값은 모두 미인증으로 취급한다.
    email_verified: payload.email_verified === true,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    ...(studentId ? { studentId } : {}),
    sohakoeMemberships: parseMemberships(payload.sohakoe_memberships),
  };
}

export function toIdentity(claims: IdpClaims): LoginIdentity {
  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified,
    name: claims.name,
    studentId: claims.studentId,
    sohakoeMemberships: claims.sohakoeMemberships,
  };
}
