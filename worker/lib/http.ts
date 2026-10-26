import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** SPEC §9 에러 형식: `{ error: { code, message } }` */
export function apiError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

export function clientIp(c: Context): string | null {
  return c.req.header("CF-Connecting-IP") ?? null;
}

export function userAgent(c: Context): string | null {
  const ua = c.req.header("User-Agent");
  return ua ? ua.slice(0, 512) : null;
}
