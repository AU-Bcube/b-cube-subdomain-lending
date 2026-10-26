import type { MiddlewareHandler } from "hono";
import { loadSession } from "../auth/session";
import type { HonoEnv } from "../types";

/** 세션 쿠키가 있으면 읽어서 c.var.session에 둔다. 인증 강제는 requireUser가 한다. */
export const sessionLoader: MiddlewareHandler<HonoEnv> = async (c, next) => {
  c.set("session", await loadSession(c));
  await next();
};
