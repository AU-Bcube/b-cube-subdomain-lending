import type { Context } from "hono";
import type { Config } from "../env";
import type { HonoEnv } from "../types";
import { requestMeta, writeAudit } from "../services/audit";
import { createSession } from "./session";

/** ID 토큰(또는 개발용 페르소나)에서 얻은 로그인 주체 */
export interface LoginIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string | undefined;
}

export type LoginDenyReason = "email_unverified" | "domain_not_allowed" | "banned";

export type LoginDecision = { ok: true } | { ok: false; reason: LoginDenyReason };

/** SPEC §6.1 허용 규칙. 순수 함수. */
export function evaluateLogin(
  config: Config,
  identity: LoginIdentity,
  existing: { banned_at: number | null } | null,
): LoginDecision {
  const email = identity.email.trim().toLowerCase();
  if (identity.emailVerified !== true) return { ok: false, reason: "email_unverified" };
  if (!email.endsWith(`@${config.allowedEmailDomain}`)) return { ok: false, reason: "domain_not_allowed" };
  if (existing?.banned_at != null) return { ok: false, reason: "banned" };
  return { ok: true };
}

/**
 * 실제 OAuth 콜백과 개발용 가짜 로그인이 공유하는 세션 생성 경로.
 * 허용 규칙 검사 → users upsert → 세션 생성 → 감사 로그 → 리다이렉트.
 */
export async function completeLogin(
  c: Context<HonoEnv>,
  identity: LoginIdentity,
  options: { dev?: boolean } = {},
): Promise<Response> {
  const db = c.env.DB;
  const email = identity.email.trim().toLowerCase();
  const devDetail = options.dev ? { dev: true } : {};
  const existing = await db
    .prepare(`SELECT banned_at FROM users WHERE email = ?`)
    .bind(email)
    .first<{ banned_at: number | null }>();

  const decision = evaluateLogin(c.var.config, { ...identity, email }, existing);
  if (!decision.ok) {
    await writeAudit(db, {
      action: "auth.login_denied",
      actorEmail: email,
      actorRole: "user",
      targetEmail: email,
      detail: { reason: decision.reason, ...devDetail },
      ...requestMeta(c),
    });
    return c.redirect(`/login?error=${decision.reason}`, 302);
  }

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO users (email, idp_sub, name, first_login_at, last_login_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         idp_sub = excluded.idp_sub,
         name = COALESCE(excluded.name, users.name),
         last_login_at = excluded.last_login_at`,
    )
    .bind(email, identity.sub, identity.name ?? null, now, now)
    .run();

  await createSession(c, email);
  await writeAudit(db, {
    action: "auth.login",
    actorEmail: email,
    actorRole: c.var.config.adminEmails.has(email) ? "admin" : "user",
    targetEmail: email,
    detail: Object.keys(devDetail).length ? devDetail : undefined,
    ...requestMeta(c),
  });
  return c.redirect("/", 302);
}
