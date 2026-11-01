import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** SPEC §9 에러 형식: `{ error: { code, message } }` */
export function apiError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** Netlify가 넣어 주는 실제 클라이언트 IP */
export function clientIp(c: Context): string | null {
  return c.req.header("x-nf-client-connection-ip") ?? null;
}

export function userAgent(c: Context): string | null {
  const ua = c.req.header("User-Agent");
  return ua ? ua.slice(0, 512) : null;
}
