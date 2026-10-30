import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256Base64url, timingSafeEqual } from "../auth/crypto";
import { recordDebugClaims } from "../auth/debug";
import { buildAuthUrl, exchangeCode, OAuthError, toIdentity, verifyIdToken } from "../auth/idp";
import { completeLogin } from "../auth/login";
import { destroySession } from "../auth/session";
import type { Config } from "../env";
import { csrf } from "../middleware/csrf";
import { requestMeta, writeAudit } from "../services/audit";
import type { HonoEnv } from "../types";

const OAUTH_COOKIE_MAX_AGE = 600;

/** 운영: `__Host-bcd_oauth`. 로컬(http)은 `__Host-`를 쓸 수 없어 `bcd_oauth` (세션 쿠키와 같은 규칙). */
export function oauthCookieName(config: Config): string {
  return config.isDev ? "bcd_oauth" : "__Host-bcd_oauth";
}

interface OAuthCookie {
  state: string;
  nonce: string;
  verifier: string;
}

// 세 값 모두 base64url이므로 '.'으로 이어 붙인다.
function encodeOAuthCookie(v: OAuthCookie): string {
  return `${v.state}.${v.nonce}.${v.verifier}`;
}

function decodeOAuthCookie(raw: string | undefined): OAuthCookie | null {
  const parts = raw?.split(".");
  if (parts?.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]{16,128}$/.test(p))) return null;
  const [state, nonce, verifier] = parts as [string, string, string];
  return { state, nonce, verifier };
}

function loginError(c: Context<HonoEnv>, code: string) {
  return c.redirect(`/login?error=${code}`, 302);
}

export const authRoutes = new Hono<HonoEnv>()
  .get("/login", async (c) => {
    const config = c.var.config;
    if (!config.oauthConfigured) {
      // 개발 모드 + DEV_FAKE_LOGIN에서만 도달한다(그 외에는 env 파싱 단계에서 실패).
      return loginError(c, "oauth_not_configured");
    }
    const flow: OAuthCookie = { state: randomToken(32), nonce: randomToken(32), verifier: randomToken(32) };
    setCookie(c, oauthCookieName(config), encodeOAuthCookie(flow), {
      httpOnly: true,
      secure: !config.isDev,
      sameSite: "Lax",
      path: "/",
      maxAge: OAUTH_COOKIE_MAX_AGE,
    });
    const codeChallenge = await sha256Base64url(flow.verifier);
    return c.redirect(buildAuthUrl(config, { state: flow.state, nonce: flow.nonce, codeChallenge }), 302);
  })
  .get("/callback", async (c) => {
    const config = c.var.config;
    if (!config.oauthConfigured) return loginError(c, "oauth_not_configured");

    // OAuth 쿠키는 한 번만 쓴다.
    const flow = decodeOAuthCookie(getCookie(c, oauthCookieName(config)));
    deleteCookie(c, oauthCookieName(config), { path: "/", secure: !config.isDev });

    const googleError = c.req.query("error");
    if (googleError) {
      // 사용자가 계정 선택을 취소한 경우 등
      console.warn("[oauth] Google 오류 응답:", googleError.slice(0, 64));
      return loginError(c, googleError === "access_denied" ? "oauth_cancelled" : "oauth_failed");
    }

    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!flow || !state || !timingSafeEqual(state, flow.state)) return loginError(c, "oauth_state");
    if (!code) return loginError(c, "oauth_failed");

    try {
      const idToken = await exchangeCode(config, code, flow.verifier);
      const claims = await verifyIdToken(config, idToken, flow.nonce);
      if (config.isDev && config.devAuthDebug) recordDebugClaims(claims);
      return await completeLogin(c, toIdentity(claims));
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      console.error("[oauth]", err.message);
      return loginError(c, "oauth_failed");
    }
  })
  .post("/logout", csrf, async (c) => {
    const session = c.var.session;
    await destroySession(c, session);
    if (session) {
      await writeAudit(c.env.DB, {
        action: "auth.logout",
        actorEmail: session.email,
        actorRole: c.var.config.adminEmails.has(session.email) ? "admin" : "user",
        targetEmail: session.email,
        ...requestMeta(c),
      });
    }
    return c.json({ ok: true });
  });
