import type { Context } from "hono";
import { clientIp, userAgent } from "../lib/http";

export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.login_denied",
  "auth.logout",
  "lease.create",
  "lease.update_records",
  "lease.renew",
  "lease.release",
  "lease.recheck",
  "lease.reactivate",
  "system.health_fail",
  "system.suspend",
  "system.expire",
  "admin.revoke",
  "admin.ban",
  "admin.unban",
  "system.drift_detected",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type ActorRole = "user" | "admin" | "system";

export interface AuditEntry {
  action: AuditAction;
  actorEmail: string | null;
  actorRole: ActorRole;
  leaseId?: string | null;
  targetEmail?: string | null;
  detail?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  at?: number;
}

export function auditStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs (at, actor_email, actor_role, action, lease_id, target_email, detail, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.at ?? Date.now(),
      entry.actorEmail,
      entry.actorRole,
      entry.action,
      entry.leaseId ?? null,
      entry.targetEmail ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      entry.ip ?? null,
      entry.userAgent ?? null,
    );
}

export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run();
}

/** 요청 컨텍스트에서 IP/User-Agent를 채운다. */
export function requestMeta(c: Context): Pick<AuditEntry, "ip" | "userAgent"> {
  return { ip: clientIp(c), userAgent: userAgent(c) };
}
