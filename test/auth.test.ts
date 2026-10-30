import { env, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Base64url } from "../worker/auth/crypto";
import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL } from "../worker/auth/idp";
import { evaluateLogin } from "../worker/auth/login";
import { parseConfig } from "../worker/env";
import { auditFor, call, createUser, login, ORIGIN, uid, workerWith } from "./helpers";

const CLIENT_ID = "test-client-id"; // vitest.config.ts 바인딩과 같은 값
const PROD_ORIGIN = "https://domain.b-cube.kr";

// ---------------------------------------------------------------------------
// 가짜 Google: 테스트 키로 서명한 id_token과 JWKS를 돌려준다.
// ---------------------------------------------------------------------------
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
let tokenRequests: URLSearchParams[] = [];
/** 다음 token endpoint 응답에 담을 id_token 클레임(오버라이드). null이면 400 응답 */
let nextClaims: ((nonce: string) => JWTPayload) | null = null;
let currentNonce = "";

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
});

async function signIdToken(payload: JWTPayload, opts: { key?: CryptoKey; expiresIn?: string } = {}) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(opts.key ?? privateKey);
}

function googleClaims(email: string, extra: JWTPayload = {}): (nonce: string) => JWTPayload {
  return (nonce) => ({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: `google-${email}`,
    email,
    email_verified: true,
    hd: email.split("@")[1],
    name: "테스트",
    nonce,
    ...extra,
  });
}

let signOverride: ((payload: JWTPayload) => Promise<string>) | null = null;

beforeEach(() => {
  tokenRequests = [];
  nextClaims = null;
  signOverride = null;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_JWKS_URL) {
      return Response.json({ keys: [publicJwk] });
    }
    if (url === GOOGLE_TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      tokenRequests.push(body);
      if (!nextClaims) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const payload = nextClaims(currentNonce);
      const idToken = signOverride ? await signOverride(payload) : await signIdToken(payload);
      return Response.json({ access_token: "at", id_token: idToken, token_type: "Bearer", expires_in: 3600 });
    }
    return realFetch(input, init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setCookies(res: Response): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const idx = pair!.indexOf("=");
    map.set(pair!.slice(0, idx), pair!.slice(idx + 1));
  }
  return map;
}

/** /auth/login → (가짜 Google) → /auth/callback 전체 흐름 */
async function oauthLogin(
  claims: ((nonce: string) => JWTPayload) | null,
  opts: { tamperState?: boolean; dropCookie?: boolean; fetcher?: (req: Request) => Promise<Response> } = {},
) {
  const fetcher = opts.fetcher ?? ((req: Request) => SELF.fetch(req));
  const start = await fetcher(new Request(`${ORIGIN}/auth/login`, { redirect: "manual" }));
  expect(start.status).toBe(302);
  const authUrl = new URL(start.headers.get("Location")!);
  const oauthCookie = setCookies(start).get("bcd_oauth")!;
  currentNonce = authUrl.searchParams.get("nonce")!;
  nextClaims = claims;

  const state = opts.tamperState ? "x".repeat(43) : authUrl.searchParams.get("state")!;
  const callback = await fetcher(
    new Request(`${ORIGIN}/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: opts.dropCookie ? {} : { Cookie: `bcd_oauth=${oauthCookie}` },
    }),
  );
  return { start, authUrl, oauthCookie, callback };
}

function location(res: Response): string | null {
  return res.headers.get("Location");
}

const PROD_VARS = {
  APP_ORIGIN: PROD_ORIGIN,
  DNS_DRY_RUN: "false",
  DEV_FAKE_LOGIN: "false",
  DEV_AUTH_DEBUG: "false",
  CF_ZONE_ID: "zone",
  CF_API_TOKEN: "token",
} as const;

// ---------------------------------------------------------------------------

describe("GET /auth/login", () => {
  it("state·nonce·PKCE를 만들고 Google로 리다이렉트한다", async () => {
    const res = await SELF.fetch(`${ORIGIN}/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("Location")!);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(p.get("scope")).toBe("openid email profile");
    expect(p.get("hd")).toBe("ajou.ac.kr");
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("code_challenge_method")).toBe("S256");

    const [line] = res.headers.getSetCookie().filter((l) => l.startsWith("bcd_oauth="));
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Lax/);
    expect(line).toMatch(/Path=\//);
    expect(line).toMatch(/Max-Age=600/);
    const [state, nonce, verifier] = line!.split(";")[0]!.slice("bcd_oauth=".length).split(".");
    expect(p.get("state")).toBe(state);
    expect(p.get("nonce")).toBe(nonce);
    expect(p.get("code_challenge")).toBe(await sha256Base64url(verifier!));
  });

  it("운영 주소에서는 __Host- 쿠키 + Secure", async () => {
    const res = await workerWith(PROD_VARS)(new Request(`${PROD_ORIGIN}/auth/login`, { redirect: "manual" }));
    expect(res.status).toBe(302);
    const [line] = res.headers.getSetCookie();
    expect(line).toMatch(/^__Host-bcd_oauth=/);
    expect(line).toMatch(/Secure/);
    expect(line).not.toMatch(/Domain=/i);
    expect(new URL(location(res)!).searchParams.get("redirect_uri")).toBe(`${PROD_ORIGIN}/auth/callback`);
  });
});

describe("GET /auth/callback — 허용", () => {
  it("@ajou.ac.kr + email_verified → 세션 생성, users upsert, 감사 로그", async () => {
    const email = `ok-${uid()}@ajou.ac.kr`;
    const { callback, oauthCookie } = await oauthLogin(googleClaims(email));
    expect(callback.status).toBe(302);
    expect(location(callback)).toBe("/");

    // 코드 교환 요청에 PKCE verifier와 redirect_uri 포함
    const verifier = oauthCookie.split(".")[2];
    expect(tokenRequests[0]?.get("code_verifier")).toBe(verifier);
    expect(tokenRequests[0]?.get("code")).toBe("test-code");
    expect(tokenRequests[0]?.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code");

    const cookies = setCookies(callback);
    expect(cookies.get("bcd_oauth")).toBe(""); // 1회용 쿠키 삭제
    const session = cookies.get("bcd_session");
    expect(session).toBeTruthy();

    const me = await SELF.fetch(`${ORIGIN}/api/me`, { headers: { Cookie: `bcd_session=${session}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email, isAdmin: false });

    const user = await env.DB.prepare(`SELECT google_sub, name FROM users WHERE email = ?`).bind(email).first();
    expect(user).toEqual({ google_sub: `google-${email}`, name: "테스트" });
    const logs = await auditFor({ action: "auth.login", targetEmail: email });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.detail).toBeNull(); // 실제 로그인은 dev 표시 없음
  });

  it("이메일은 소문자로 정규화한다", async () => {
    const id = uid();
    const { callback } = await oauthLogin(googleClaims(`Mixed-${id}@AJOU.ac.kr`, { hd: "ajou.ac.kr" }));
    expect(location(callback)).toBe("/");
    const row = await env.DB.prepare(`SELECT email FROM users WHERE email = ?`).bind(`mixed-${id}@ajou.ac.kr`).first();
    expect(row).toBeTruthy();
  });

  it("iss가 accounts.google.com(스킴 없음)이어도 허용", async () => {
    const { callback } = await oauthLogin(googleClaims(`iss-${uid()}@ajou.ac.kr`, { iss: "accounts.google.com" }));
    expect(location(callback)).toBe("/");
  });

  it("관리자 예외: ADMIN_EMAILS는 도메인 검사를 면제한다", async () => {
    const fetcher = workerWith({ ADMIN_EMAILS: "boss@gmail.com" });
    const { callback } = await oauthLogin(googleClaims("boss@gmail.com", { hd: undefined }), { fetcher });
    expect(location(callback)).toBe("/");
    const logs = await auditFor({ action: "auth.login", targetEmail: "boss@gmail.com" });
    expect(logs.at(-1)?.actor_role).toBe("admin");
  });

  it("REQUIRE_HD=true이고 hd가 일치하면 허용", async () => {
    const fetcher = workerWith({ REQUIRE_HD: "true" });
    const { callback } = await oauthLogin(googleClaims(`hd-${uid()}@ajou.ac.kr`), { fetcher });
    expect(location(callback)).toBe("/");
  });
});

describe("GET /auth/callback — 거부", () => {
  async function expectDenied(
    claims: (nonce: string) => JWTPayload,
    reason: string,
    fetcher?: (req: Request) => Promise<Response>,
  ) {
    const email = String(claims("n").email).toLowerCase();
    const { callback } = await oauthLogin(claims, fetcher ? { fetcher } : {});
    expect(callback.status).toBe(302);
    expect(location(callback)).toBe(`/login?error=${reason}`);
    expect(setCookies(callback).has("bcd_session")).toBe(false);
    const logs = await auditFor({ action: "auth.login_denied", targetEmail: email });
    expect(logs.at(-1)?.detail).toMatchObject({ reason });
  }

  it("다른 도메인", async () => {
    await expectDenied(googleClaims(`x-${uid()}@gmail.com`, { hd: undefined }), "domain_not_allowed");
  });

  it("도메인을 접미사로 흉내 낸 주소 (evil-ajou.ac.kr)", async () => {
    await expectDenied(googleClaims(`x-${uid()}@evil-ajou.ac.kr`), "domain_not_allowed");
  });

  it("email_verified=false", async () => {
    await expectDenied(googleClaims(`nv-${uid()}@ajou.ac.kr`, { email_verified: false }), "email_unverified");
  });

  it("email_verified가 문자열 \"true\"여도 미인증으로 취급", async () => {
    await expectDenied(googleClaims(`sv-${uid()}@ajou.ac.kr`, { email_verified: "true" }), "email_unverified");
  });

  it("관리자도 email_verified는 필요하다", async () => {
    const fetcher = workerWith({ ADMIN_EMAILS: "boss2@gmail.com" });
    await expectDenied(googleClaims("boss2@gmail.com", { email_verified: false }), "email_unverified", fetcher);
  });

  it("REQUIRE_HD=true인데 hd 없음", async () => {
    const fetcher = workerWith({ REQUIRE_HD: "true" });
    await expectDenied(googleClaims(`nohd-${uid()}@ajou.ac.kr`, { hd: undefined }), "hd_mismatch", fetcher);
  });

  it("차단된 사용자", async () => {
    const email = `ban-${uid()}@ajou.ac.kr`;
    await createUser(email, { banned: true });
    await expectDenied(googleClaims(email), "banned");
  });
});

describe("GET /auth/callback — OAuth 흐름 오류", () => {
  it("state 불일치 → oauth_state, 코드 교환 안 함", async () => {
    const { callback } = await oauthLogin(googleClaims(`s-${uid()}@ajou.ac.kr`), { tamperState: true });
    expect(location(callback)).toBe("/login?error=oauth_state");
    expect(tokenRequests).toHaveLength(0);
  });

  it("OAuth 쿠키 없음 → oauth_state", async () => {
    const { callback } = await oauthLogin(googleClaims(`c-${uid()}@ajou.ac.kr`), { dropCookie: true });
    expect(location(callback)).toBe("/login?error=oauth_state");
    expect(tokenRequests).toHaveLength(0);
  });

  it("사용자가 취소 (error=access_denied) → oauth_cancelled", async () => {
    const res = await SELF.fetch(`${ORIGIN}/auth/callback?error=access_denied&state=x`, { redirect: "manual" });
    expect(location(res)).toBe("/login?error=oauth_cancelled");
  });

  it("코드 교환 실패 → oauth_failed", async () => {
    const { callback } = await oauthLogin(null);
    expect(location(callback)).toBe("/login?error=oauth_failed");
  });

  const invalidTokens: Array<[string, (email: string) => (nonce: string) => JWTPayload]> = [
    ["nonce 불일치", (e) => googleClaims(e, { nonce: "other-nonce" })],
    ["aud가 다른 클라이언트", (e) => googleClaims(e, { aud: "someone-else" })],
    ["iss가 Google이 아님", (e) => googleClaims(e, { iss: "https://evil.example.com" })],
  ];
  for (const [title, claims] of invalidTokens) {
    it(`${title} → oauth_failed, 세션 없음`, async () => {
      const email = `t-${uid()}@ajou.ac.kr`;
      const { callback } = await oauthLogin(claims(email));
      expect(location(callback)).toBe("/login?error=oauth_failed");
      expect(setCookies(callback).has("bcd_session")).toBe(false);
      expect(await env.DB.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first()).toBeNull();
    });
  }

  it("만료된 id_token → oauth_failed", async () => {
    signOverride = (payload) => signIdToken({ ...payload }, { expiresIn: "-1m" });
    const { callback } = await oauthLogin(googleClaims(`exp-${uid()}@ajou.ac.kr`));
    expect(location(callback)).toBe("/login?error=oauth_failed");
  });

  it("다른 키로 서명한 id_token → oauth_failed", async () => {
    const other = await generateKeyPair("RS256");
    signOverride = (payload) => signIdToken(payload, { key: other.privateKey });
    const { callback } = await oauthLogin(googleClaims(`key-${uid()}@ajou.ac.kr`));
    expect(location(callback)).toBe("/login?error=oauth_failed");
  });
});

describe("evaluateLogin (허용 규칙 순수 함수)", () => {
  const base = parseConfig(env);
  const id = (email: string, extra: Partial<Parameters<typeof evaluateLogin>[1]> = {}) => ({
    sub: "s",
    email,
    emailVerified: true,
    hd: "ajou.ac.kr",
    ...extra,
  });

  it("규칙 순서: 미인증 → 도메인 → hd → 차단", () => {
    const hdConfig = parseConfig({ ...env, REQUIRE_HD: "true" } as unknown as Env);
    expect(evaluateLogin(base, id("a@gmail.com", { emailVerified: false }), null)).toEqual({ ok: false, reason: "email_unverified" });
    expect(evaluateLogin(base, id("a@gmail.com"), null)).toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(evaluateLogin(hdConfig, id("a@ajou.ac.kr", { hd: "gmail.com" }), null)).toEqual({ ok: false, reason: "hd_mismatch" });
    expect(evaluateLogin(base, id("a@ajou.ac.kr"), { banned_at: 1 })).toEqual({ ok: false, reason: "banned" });
    expect(evaluateLogin(base, id("a@ajou.ac.kr", { hd: undefined }), null)).toEqual({ ok: true });
  });

  it("차단은 관리자 예외보다 우선한다", () => {
    expect(evaluateLogin(base, id("t-admin@ajou.ac.kr"), { banned_at: 1 })).toEqual({ ok: false, reason: "banned" });
  });
});

describe("CSRF: POST /auth/logout", () => {
  it("Origin 누락, 다른 서브도메인 Origin, 토큰 불일치 → 403, 세션 유지", async () => {
    const s = await login(`lo-${uid()}@ajou.ac.kr`);
    for (const opts of [{ origin: null }, { origin: "https://alice.b-cube.kr" }, { origin: "http://localhost:5174" }, { csrf: "wrong" }, { csrf: null }]) {
      const res = await call("/auth/logout", { method: "POST", session: s, ...opts });
      expect(res.status).toBe(403);
    }
    expect((await call("/api/me", { session: s })).status).toBe(200);
    expect(await auditFor({ action: "auth.logout", targetEmail: s.email })).toHaveLength(0);
  });

  it("정상 요청 → 세션 삭제, 쿠키 만료, 감사 로그", async () => {
    const s = await login(`lo-${uid()}@ajou.ac.kr`);
    const res = await call("/auth/logout", { method: "POST", session: s });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((l) => /^bcd_session=;/.test(l) && /Max-Age=0/.test(l))).toBe(true);
    expect((await call("/api/me", { session: s })).status).toBe(401);
    expect(await auditFor({ action: "auth.logout", targetEmail: s.email })).toHaveLength(1);
  });
});

describe("보안 헤더", () => {
  it("API 응답에 CSP, nosniff, Referrer-Policy, X-Frame-Options, no-store", async () => {
    for (const path of ["/api/health", "/api/me", "/api/does-not-exist"]) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://accounts.google.com");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("리다이렉트 응답에도 적용", async () => {
    const res = await SELF.fetch(`${ORIGIN}/auth/login`, { redirect: "manual" });
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("개발 기능 차단", () => {
  const DEV_PATHS = ["/auth/dev-login?as=admin", "/api/dev/config", "/auth/debug"];

  it("운영 주소에서는 dev-login, dev/config, debug가 404", async () => {
    const fetcher = workerWith(PROD_VARS);
    expect((await fetcher(new Request(`${PROD_ORIGIN}/api/health`))).status).toBe(200);
    for (const path of DEV_PATHS) {
      const res = await fetcher(new Request(`${PROD_ORIGIN}${path}`, { redirect: "manual" }));
      expect(res.status, path).toBe(404);
    }
  });

  for (const flag of ["DEV_FAKE_LOGIN", "DEV_AUTH_DEBUG", "DNS_DRY_RUN"] as const) {
    it(`운영 주소에서 ${flag}=true이면 모든 요청 500`, async () => {
      const fetcher = workerWith({ ...PROD_VARS, [flag]: "true" });
      for (const path of ["/api/health", "/auth/login", "/api/me", ...DEV_PATHS]) {
        const res = await fetcher(new Request(`${PROD_ORIGIN}${path}`, { redirect: "manual" }));
        expect(res.status, path).toBe(500);
        expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      }
    });
  }

  it("localhost라도 플래그가 꺼져 있으면 dev-login, debug는 404", async () => {
    // vitest.config.ts: DEV_FAKE_LOGIN=false, DEV_AUTH_DEBUG=false
    for (const path of ["/auth/dev-login?as=admin", "/auth/debug"]) {
      expect((await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" })).status, path).toBe(404);
    }
  });

  it("dev-login?as=banned는 실제 로그인과 같은 거부 흐름 (리다이렉트, 감사 로그)", async () => {
    const fetcher = workerWith({ DEV_FAKE_LOGIN: "true" });
    const email = "banned@ajou.ac.kr";
    const exists = await env.DB.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first();
    if (!exists) await createUser(email, { banned: true });

    const dev = await fetcher(new Request(`${ORIGIN}/auth/dev-login?as=banned`, { redirect: "manual" }));
    const real = (await oauthLogin(googleClaims(email), { fetcher })).callback;
    for (const res of [dev, real]) {
      expect(res.status).toBe(302);
      expect(location(res)).toBe("/login?error=banned");
      expect(setCookies(res).has("bcd_session")).toBe(false);
    }
    const logs = await auditFor({ action: "auth.login_denied", targetEmail: email });
    expect(logs.map((l) => l.detail)).toEqual([
      expect.objectContaining({ reason: "banned", dev: true }),
      expect.objectContaining({ reason: "banned" }),
    ]);
    expect(logs[1]?.detail).not.toHaveProperty("dev");
  });

  it("dev-login 성공은 실제 로그인과 같은 세션 쿠키 + auth.login 감사 로그(dev: true)", async () => {
    const fetcher = workerWith({ DEV_FAKE_LOGIN: "true" });
    const res = await fetcher(new Request(`${ORIGIN}/auth/dev-login?as=new`, { redirect: "manual" }));
    expect(location(res)).toBe("/");
    const [line] = res.headers.getSetCookie().filter((l) => l.startsWith("bcd_session="));
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Lax/);
    expect(line).toMatch(/Max-Age=604800/);
    const logs = await auditFor({ action: "auth.login", targetEmail: "newbie@ajou.ac.kr" });
    expect(logs.at(-1)?.detail).toEqual({ dev: true });
  });

  it("/auth/debug (DEV_AUTH_DEBUG=true): 마지막 로그인의 email, email_verified, hd 표시", async () => {
    const fetcher = workerWith({ DEV_AUTH_DEBUG: "true" });
    const email = `dbg-${uid()}@ajou.ac.kr`;
    await oauthLogin(googleClaims(email), { fetcher });
    const res = await fetcher(new Request(`${ORIGIN}/auth/debug`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(email);
    expect(html).toContain("<code>true</code>");
    expect(html).toContain("<code>ajou.ac.kr</code>");
  });
});
