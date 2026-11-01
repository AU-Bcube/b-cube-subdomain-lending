import { getApp } from "./app";
import { runScheduled, type CronJob } from "./cron";
import { type Env, getConfig } from "./env";
import { applySecurityHeaders } from "./middleware/security-headers";

function configErrorResponse(path: string): Response {
  const res = new Response(
    JSON.stringify({ error: { code: "config_error", message: "서버 설정 오류입니다. 관리자에게 문의하세요." } }),
    { status: 500, headers: { "Content-Type": "application/json; charset=UTF-8" } },
  );
  applySecurityHeaders(res.headers, path);
  return res;
}

/** `/api/*`, `/auth/*` 요청 처리. Netlify 함수(netlify/functions/api.ts)와 테스트가 호출한다. */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  let config;
  try {
    config = getConfig(env);
  } catch (err) {
    // 운영 주소 + 개발 플래그(UnsafeConfigError) 또는 필수값 누락: 모든 요청을 500으로 막는다.
    console.error("[config]", err instanceof Error ? err.message : err);
    return configErrorResponse(new URL(request.url).pathname);
  }
  return getApp(config).fetch(request, env);
}

/** 예약 작업 실행. Netlify 예약 함수(netlify/functions/cron-*.ts)가 호출한다. */
export async function handleScheduled(job: CronJob, env: Env): Promise<void> {
  let config;
  try {
    config = getConfig(env);
  } catch (err) {
    console.error("[config] scheduled 작업 중단:", err instanceof Error ? err.message : err);
    return;
  }
  await runScheduled(job, env, config);
}
