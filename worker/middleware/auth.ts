import type { MiddlewareHandler } from "hono";
import { apiError } from "../lib/http";
import type { HonoEnv } from "../types";

/** 유효한 세션 + 차단되지 않은 사용자. 세션이 살아 있어도 차단되면 즉시 401. */
export const requireUser: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const session = c.var.session;
  if (!session || session.bannedAt != null) {
    return apiError(c, 401, "unauthorized", "로그인이 필요합니다.");
  }
  c.set("user", {
    email: session.email,
    name: session.name,
    isAdmin: c.var.config.adminEmails.has(session.email),
    csrfToken: session.csrfToken,
  });
  return next();
};

/** requireUser 이후에 사용한다. */
export const requireAdmin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!c.var.user?.isAdmin) {
    return apiError(c, 403, "forbidden", "관리자만 사용할 수 있습니다.");
  }
  return next();
};
