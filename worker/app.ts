import { Hono } from "hono";
import { type Config, getConfig } from "./env";
import { apiError } from "./lib/http";
import { csrf } from "./middleware/csrf";
import { securityHeaders } from "./middleware/security-headers";
import { sessionLoader } from "./middleware/session";
import { authRoutes } from "./routes/auth";
import { devApiRoutes, devAuthRoutes, devDebugRoutes } from "./routes/dev";
import { meRoutes } from "./routes/me";
import type { HonoEnv } from "./types";

/**
 * 설정에 따라 라우트를 등록한 Hono 앱을 만든다.
 * 개발 전용 라우트는 조건을 만족하지 않으면 등록 자체를 하지 않아 404가 된다.
 */
export function createApp(config: Config): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.use("*", securityHeaders);
  app.use("*", async (c, next) => {
    // 앱은 라우트 구성 키 단위로 캐시되므로 설정 값은 요청마다 env에서 읽는다(파싱 결과는 캐시됨).
    c.set("config", getConfig(c.env));
    await next();
  });
  app.use("/api/*", sessionLoader, csrf);
  app.use("/auth/*", sessionLoader);

  app.get("/api/health", async (c) => {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok", time: new Date().toISOString() });
  });
  app.route("/api/me", meRoutes);
  app.route("/auth", authRoutes);

  if (config.isDev) {
    app.route("/api/dev", devApiRoutes);
    if (config.devFakeLogin) app.route("/auth", devAuthRoutes);
    if (config.devAuthDebug) app.route("/auth", devDebugRoutes);
  }

  app.notFound((c) => apiError(c, 404, "not_found", "요청한 경로를 찾을 수 없습니다."));
  app.onError((err, c) => {
    console.error("[unhandled]", c.req.method, c.req.path, err);
    return apiError(c, 500, "internal_error", "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  });
  return app;
}

const apps = new Map<string, Hono<HonoEnv>>();

export function getApp(config: Config): Hono<HonoEnv> {
  // 라우트 구성에 영향을 주는 값만 키로 쓴다.
  const key = `${config.isDev}:${config.devFakeLogin}:${config.devAuthDebug}`;
  let app = apps.get(key);
  if (!app) {
    app = createApp(config);
    apps.set(key, app);
  }
  return app;
}
