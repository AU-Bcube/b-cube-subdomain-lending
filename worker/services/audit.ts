import type { Context } from "hono";
import type { ActorRole, AuditAction } from "../../shared/schemas";
import type { Database, Write } from "../db";
import { clientIp, userAgent } from "../lib/http";

export { AUDIT_ACTIONS, type ActorRole, type AuditAction } from "../../shared/schemas";

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

export function auditStatement(db: Database, entry: AuditEntry): Write {
  return db.write((session) =>
    db.auditLogs.insertOne(
      {
        at: entry.at ?? Date.now(),
        actor_email: entry.actorEmail,
        actor_role: entry.actorRole,
        action: entry.action,
        lease_id: entry.leaseId ?? null,
        target_email: entry.targetEmail ?? null,
        detail: entry.detail ?? null,
        ip: entry.ip ?? null,
        user_agent: entry.userAgent ?? null,
      },
      { session },
    ),
  );
}

export async function writeAudit(db: Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run();
}

/** 요청 컨텍스트에서 IP/User-Agent를 채운다. */
export function requestMeta(c: Context): Pick<AuditEntry, "ip" | "userAgent"> {
  return { ip: clientIp(c), userAgent: userAgent(c) };
}
