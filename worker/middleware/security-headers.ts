import type { MiddlewareHandler } from "hono";

/** SPEC §6.4. 정적 자산 응답에는 public/_headers로 같은 헤더를 붙인다. */
export const CSP =
  "default-src 'self'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
  "font-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com";

export function applySecurityHeaders(headers: Headers, path: string): void {
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  if (path.startsWith("/api/") || path.startsWith("/auth/")) {
    headers.set("Cache-Control", "no-store");
  }
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  // 리다이렉트 등 불변 헤더 응답에도 적용하기 위해 새 Response로 감싼다.
  try {
    applySecurityHeaders(c.res.headers, c.req.path);
  } catch {
    const res = new Response(c.res.body, c.res);
    applySecurityHeaders(res.headers, c.req.path);
    c.res = res;
  }
};
