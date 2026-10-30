import type { Context } from "hono";
import type { Config } from "../env";
import type { HonoEnv } from "../types";
import { requestMeta, writeAudit } from "../services/audit";
import { createSession } from "./session";

/** IdP `sohakoe_memberships` 클레임의 항목 */
export interface SohakoeMembership {
  name: string;
  year?: string;
  semester?: string;
  from?: string;
  to?: string;
}

/** ID 토큰(또는 개발용 페르소나)에서 얻은 로그인 주체 */
export interface LoginIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string | undefined;
  studentId?: string | undefined;
  sohakoeMemberships: SohakoeMembership[];
}

export type LoginDenyReason = "email_unverified" | "domain_not_allowed" | "sohakoe_required" | "banned";

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
  const isMember = identity.sohakoeMemberships.some((m) => m.name.trim().toLowerCase() === config.requiredSohakoe);
  if (!isMember && !config.adminEmails.has(email)) return { ok: false, reason: "sohakoe_required" };
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
  // 사용자는 sub로 식별한다. email은 sub가 처음 보일 때 기존 계정을 잇는 데만 쓴다.
  const { results: matches } = await db
    .prepare(`SELECT email, idp_sub, banned_at FROM users WHERE idp_sub = ? OR email = ?`)
    .bind(identity.sub, email)
    .all<{ email: string; idp_sub: string; banned_at: number | null }>();
  const existing = matches.find((u) => u.idp_sub === identity.sub) ?? matches[0] ?? null;
  const accountEmail = existing?.email ?? email;

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
      `INSERT INTO users (email, idp_sub, name, student_id, sohakoe_memberships, first_login_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         idp_sub = excluded.idp_sub,
         name = COALESCE(excluded.name, users.name),
         student_id = COALESCE(excluded.student_id, users.student_id),
         sohakoe_memberships = excluded.sohakoe_memberships,
         last_login_at = excluded.last_login_at`,
    )
    .bind(
      accountEmail,
      identity.sub,
      identity.name ?? null,
      identity.studentId ?? null,
      JSON.stringify(identity.sohakoeMemberships),
      now,
      now,
    )
    .run();

  await createSession(c, accountEmail);
  await writeAudit(db, {
    action: "auth.login",
    actorEmail: accountEmail,
    actorRole: c.var.config.adminEmails.has(accountEmail) ? "admin" : "user",
    targetEmail: accountEmail,
    detail: Object.keys(devDetail).length ? devDetail : undefined,
    ...requestMeta(c),
  });
  return c.redirect("/", 302);
}
