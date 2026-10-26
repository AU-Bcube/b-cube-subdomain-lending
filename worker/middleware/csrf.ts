import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "../auth/crypto";
import { apiError } from "../lib/http";
import type { HonoEnv } from "../types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * SPEC §6.3. *.b-cube.kr 서브도메인은 콘솔과 same-site이므로 SameSite 쿠키만으로는 부족하다.
 * 상태 변경 요청은 Origin 정확 일치 + X-CSRF-Token(세션 값과 상수 시간 비교)을 모두 요구한다.
 */
export const csrf: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const origin = c.req.header("Origin");
  if (!origin || origin !== c.var.config.appOrigin) {
    return apiError(c, 403, "csrf_origin", "허용되지 않은 출처의 요청입니다.");
  }
  const session = c.var.session;
  const token = c.req.header("X-CSRF-Token");
  if (!session || !token || !timingSafeEqual(token, session.csrfToken)) {
    return apiError(c, 403, "csrf_token", "보안 토큰이 유효하지 않습니다. 페이지를 새로고침해 주세요.");
  }
  return next();
};
