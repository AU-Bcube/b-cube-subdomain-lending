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
  await c.env.DB.prepare(
    `INSERT INTO sessions (id_hash, email, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(idHash, email, randomToken(32), now, now + SESSION_TTL_MS)
    .run();
  setCookie(c, sessionCookieName(config), token, cookieOptions(config, SESSION_TTL_MS / 1000));
}

export async function loadSession(c: Context<HonoEnv>): Promise<SessionInfo | null> {
  const token = getCookie(c, sessionCookieName(c.var.config));
  if (!token || token.length > 128) return null;
  const idHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id_hash, s.email, s.csrf_token, s.expires_at, u.name, u.banned_at
       FROM sessions s JOIN users u ON u.email = s.email
      WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(idHash, Date.now())
    .first<{
      id_hash: string;
      email: string;
      csrf_token: string;
      expires_at: number;
      name: string | null;
      banned_at: number | null;
    }>();
  if (!row) return null;
  return {
    idHash: row.id_hash,
    email: row.email,
    name: row.name,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
    bannedAt: row.banned_at,
  };
}

export async function destroySession(c: Context<HonoEnv>, session: SessionInfo | null): Promise<void> {
  if (session) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(session.idHash).run();
  }
  clearSessionCookie(c);
}

export function clearSessionCookie(c: Context<HonoEnv>): void {
  const config = c.var.config;
  deleteCookie(c, sessionCookieName(config), { path: "/", secure: !config.isDev });
}
