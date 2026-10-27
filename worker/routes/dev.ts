import { Hono } from "hono";
import type { DevConfig } from "../../shared/schemas";
import { lastDebugClaims } from "../auth/debug";
import { completeLogin } from "../auth/login";
import { DEV_PERSONAS } from "../data/dev-personas";
import { apiError } from "../lib/http";
import type { HonoEnv } from "../types";

/** GET /api/dev/config: 개발 모드에서만 등록된다. 프론트는 이 응답으로 DEV 배지와 페르소나 목록을 결정한다. */
export const devApiRoutes = new Hono<HonoEnv>().get("/config", (c) => {
  const config = c.var.config;
  const body: DevConfig = {
    fakeLogin: config.devFakeLogin,
    dnsDryRun: config.dnsDryRun,
    oauthConfigured: config.oauthConfigured,
    personas: config.devFakeLogin ? DEV_PERSONAS.map(({ as, email, label }) => ({ as, email, label })) : [],
  };
  return c.json(body);
});

/** GET /auth/dev-login?as=<persona>: DEV_FAKE_LOGIN=true이고 localhost일 때만 등록된다. */
export const devAuthRoutes = new Hono<HonoEnv>().get("/dev-login", async (c) => {
  const persona = DEV_PERSONAS.find((p) => p.as === c.req.query("as"));
  if (!persona) return apiError(c, 400, "unknown_persona", "알 수 없는 페르소나입니다.");
  return completeLogin(
    c,
    { sub: persona.sub, email: persona.email, emailVerified: true, hd: "ajou.ac.kr", name: persona.name },
    { dev: true },
  );
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** GET /auth/debug: DEV_AUTH_DEBUG=true이고 localhost일 때만 등록된다. 마지막 로그인의 ID 토큰 클레임을 보여준다. */
export const devDebugRoutes = new Hono<HonoEnv>().get("/debug", (c) => {
  const claims = lastDebugClaims();
  const rows = claims
    ? [
        ["시각", new Date(claims.at).toISOString()],
        ["email", claims.email],
        ["email_verified", String(claims.email_verified)],
        ["hd", claims.hd ?? "(없음)"],
      ]
        .map(([k, v]) => `<tr><th>${escapeHtml(k!)}</th><td><code>${escapeHtml(v!)}</code></td></tr>`)
        .join("")
    : "";
  const body = claims
    ? `<table>${rows}</table>
       <p>hd가 <code>${escapeHtml(c.var.config.allowedEmailDomain)}</code>이면 <code>REQUIRE_HD=true</code>, 없으면 <code>REQUIRE_HD=false</code>로 설정한다.</p>`
    : `<p>기록된 로그인이 없습니다. <a href="/auth/login">Google로 로그인</a>한 뒤 다시 여세요. (dev 서버를 재시작하면 기록이 사라집니다)</p>`;
  return c.html(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Auth debug</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:40rem}th{text-align:left;padding-right:1rem}td,th{padding:.25rem 0}</style>
</head><body><h1>ID 토큰 클레임 (개발 전용)</h1>${body}</body></html>`);
});
