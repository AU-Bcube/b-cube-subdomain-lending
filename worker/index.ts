import { getApp } from "./app";
import { getConfig } from "./env";
import { applySecurityHeaders } from "./middleware/security-headers";

function configErrorResponse(path: string): Response {
  const res = new Response(
    JSON.stringify({ error: { code: "config_error", message: "서버 설정 오류입니다. 관리자에게 문의하세요." } }),
    { status: 500, headers: { "Content-Type": "application/json; charset=UTF-8" } },
  );
  applySecurityHeaders(res.headers, path);
  return res;
}

export default {
  async fetch(request, env, ctx) {
    let config;
    try {
      config = getConfig(env);
    } catch (err) {
      // 운영 주소 + 개발 플래그(UnsafeConfigError) 또는 필수값 누락: 모든 요청을 500으로 막는다.
      console.error("[config]", err instanceof Error ? err.message : err);
      return configErrorResponse(new URL(request.url).pathname);
    }
    return getApp(config).fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    let config;
    try {
      config = getConfig(env);
    } catch (err) {
      console.error("[config] scheduled 작업 중단:", err instanceof Error ? err.message : err);
      return;
    }
    // TODO(M7): controller.cron 값으로 만료/헬스/드리프트 작업 분기
    void config;
    void ctx;
    console.log("[cron] 미구현:", controller.cron);
  },
} satisfies ExportedHandler<Env>;
