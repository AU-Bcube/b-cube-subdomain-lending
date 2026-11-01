import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../env";
import type { HonoEnv, SessionInfo } from "../types";
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 운영: `__Host-bcd_session` (Domain 속성 없음 → 형제 서브도메인의 cookie tossing 차단)
 * 로컬(http): `__Host-`와 Secure를 쓸 수 없으므로 `bcd_session`. APP_ORIGIN이 localhost일 때만 허용된다.
 */
export function sessionCookieName(config: Config): string {
  return config.isDev ? "bcd_session" : "__Host-bcd_session";
}

function cookieOptions(config: Config, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: !config.isDev,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export async function createSession(c: Context<HonoEnv>, email: string): Promise<void> {
  const config = c.var.config;
  const token = randomToken(32);
  const idHash = await sha256Hex(token);
  const now = Date.now();
  await c.env.DB.sessions.insertOne({
    id_hash: idHash,
    email,
    csrf_token: randomToken(32),
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  });
  setCookie(c, sessionCookieName(config), token, cookieOptions(config, SESSION_TTL_MS / 1000));
}

export async function loadSession(c: Context<HonoEnv>): Promise<SessionInfo | null> {
  const token = getCookie(c, sessionCookieName(c.var.config));
  if (!token || token.length > 128) return null;
  const idHash = await sha256Hex(token);
  const db = c.env.DB;
  const row = await db.sessions.findOne({ id_hash: idHash, expires_at: { $gt: Date.now() } });
  if (!row) return null;
  const user = await db.users.findOne({ email: row.email });
  if (!user) return null;
  return {
    idHash: row.id_hash,
    email: row.email,
    name: user.name,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
    bannedAt: user.banned_at,
  };
}

export async function destroySession(c: Context<HonoEnv>, session: SessionInfo | null): Promise<void> {
  if (session) {
    await c.env.DB.sessions.deleteOne({ id_hash: session.idHash });
  }
  clearSessionCookie(c);
}

export function clearSessionCookie(c: Context<HonoEnv>): void {
  const config = c.var.config;
  deleteCookie(c, sessionCookieName(config), { path: "/", secure: !config.isDev });
}
