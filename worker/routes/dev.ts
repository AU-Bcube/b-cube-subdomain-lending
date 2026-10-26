import { Hono } from "hono";
import type { DevConfig } from "../../shared/schemas";
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
