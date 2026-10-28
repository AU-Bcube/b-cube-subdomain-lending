import { Hono, type Context } from "hono";
import { z } from "zod";
import { LEASE_STATUSES } from "../../shared/rules";
import {
  AUDIT_ACTIONS,
  optionalReasonSchema,
  reasonSchema,
  type AdminLeaseItem,
  type AdminUserItem,
  type AuditLogItem,
  type DriftItem,
  type DriftRepairSummary,
  type DriftResponse,
  type RecoverOpsResponse,
  type Paged,
} from "../../shared/schemas";
import { apiError } from "../lib/http";
import { requireAdmin, requireUser } from "../middleware/auth";
import { auditStatement, requestMeta, writeAudit } from "../services/audit";
import { createDnsClient, DnsError } from "../services/cloudflare-dns";
import type { DnsOpRow } from "../services/dns-ops";
import { acquireLock, getLock, RECOVER_LOCK, RECOVER_LOCK_MS } from "../services/job-lock";
import { changedCount, recoverPendingOps } from "../services/repair";
import {
  getLease,
  getRecordsByLease,
  LeaseStateError,
  revokeLease,
  toRecordView,
  type Actor,
  type LeaseRow,
} from "../services/leases";
import type { HonoEnv } from "../types";

const LEASES_PAGE_SIZE = 20;
const USERS_PAGE_SIZE = 20;
const AUDIT_PAGE_SIZE = 25;

const page = z.coerce.number().int().min(1).max(100_000).catch(1);
const optionalText = z.string().trim().max(200).optional().catch(undefined);
const optionalMs = z.coerce.number().int().min(0).optional().catch(undefined);

/** LIKE 검색어의 와일드카드 이스케이프. `ESCAPE '\'`와 함께 쓴다. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

async function readBody<T>(c: Context<HonoEnv>, schema: z.ZodType<T>): Promise<T | Response> {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return apiError(c, 400, "invalid_input", parsed.error.issues[0]?.message ?? "입력값이 올바르지 않습니다.");
  }
  return parsed.data;
}

function adminActor(c: Context<HonoEnv>): Actor {
  return { email: c.var.user.email, role: "admin", ...requestMeta(c) };
}

function leaseItem(row: LeaseRow, records: AdminLeaseItem["records"]): AdminLeaseItem {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    targetKind: row.target_kind,
    status: row.status,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    healthFailCount: row.health_fail_count,
    lastHealthCheckAt: row.last_health_check_at,
    records,
  };
}

function parseDetail(detail: string | null): unknown {
  if (detail === null) return null;
  try {
    return JSON.parse(detail);
  } catch {
    return detail;
  }
}

export const adminRoutes = new Hono<HonoEnv>()
  .use("*", requireUser, requireAdmin)

  // 전체 lease (이름/소유자 검색)
  .get("/leases", async (c) => {
    const query = z
      .object({ status: z.enum(LEASE_STATUSES).optional().catch(undefined), q: optionalText, page })
      .parse(c.req.query());
    const where: string[] = [];
    const binds: unknown[] = [];
    if (query.status) {
      where.push("status = ?");
      binds.push(query.status);
    }
    if (query.q) {
      where.push(`(name LIKE ? ESCAPE '\\' OR owner_email LIKE ? ESCAPE '\\')`);
      binds.push(likeContains(query.q.toLowerCase()), likeContains(query.q.toLowerCase()));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const db = c.env.DB;
    const total = await db.prepare(`SELECT COUNT(*) AS n FROM leases ${whereSql}`).bind(...binds).first<{ n: number }>();
    const { results } = await db
      .prepare(`SELECT * FROM leases ${whereSql} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .bind(...binds, LEASES_PAGE_SIZE, (query.page - 1) * LEASES_PAGE_SIZE)
      .all<LeaseRow>();
    const records = await getRecordsByLease(db, results.map((r) => r.id));
    const body: Paged<AdminLeaseItem> = {
      items: results.map((row) => leaseItem(row, (records.get(row.id) ?? []).map(toRecordView))),
      total: total?.n ?? 0,
      page: query.page,
      pageSize: LEASES_PAGE_SIZE,
    };
    return c.json(body);
  })

  // 강제 회수
  .post("/leases/:id/revoke", async (c) => {
    const input = await readBody(c, reasonSchema);
    if (input instanceof Response) return input;
    const db = c.env.DB;
    const lease = await getLease(db, c.req.param("id"));
    if (!lease) return apiError(c, 404, "not_found", "lease를 찾을 수 없습니다.");
    try {
      await revokeLease(db, createDnsClient(c.var.config), lease, input.reason, adminActor(c));
    } catch (err) {
      if (err instanceof LeaseStateError) return apiError(c, 409, "invalid_status", err.message);
      if (err instanceof DnsError) return apiError(c, 502, "dns_error", err.message);
      throw err;
    }
    return c.json({ ok: true });
  })

  // 사용자 목록, 보유 lease 수
  .get("/users", async (c) => {
    const query = z
      .object({ q: optionalText, banned: z.enum(["true", "false"]).optional().catch(undefined), page })
      .parse(c.req.query());
    const where: string[] = [];
    const binds: unknown[] = [];
    if (query.q) {
      where.push(`(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`);
      binds.push(likeContains(query.q.toLowerCase()), likeContains(query.q));
    }
    if (query.banned === "true") where.push("u.banned_at IS NOT NULL");
    if (query.banned === "false") where.push("u.banned_at IS NULL");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const db = c.env.DB;
    const total = await db.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`).bind(...binds).first<{ n: number }>();
    const { results } = await db
      .prepare(
        `SELECT u.email, u.name, u.first_login_at, u.last_login_at, u.banned_at, u.ban_reason,
                (SELECT COUNT(*) FROM leases l WHERE l.owner_email = u.email AND l.status IN ('active','suspended')) AS live_count,
                (SELECT COUNT(*) FROM leases l WHERE l.owner_email = u.email) AS total_count
           FROM users u ${whereSql}
          ORDER BY u.last_login_at DESC, u.email
          LIMIT ? OFFSET ?`,
      )
      .bind(...binds, USERS_PAGE_SIZE, (query.page - 1) * USERS_PAGE_SIZE)
      .all<{
        email: string;
        name: string | null;
        first_login_at: number;
        last_login_at: number;
        banned_at: number | null;
        ban_reason: string | null;
        live_count: number;
        total_count: number;
      }>();
    const admins = c.var.config.adminEmails;
    const body: Paged<AdminUserItem> = {
      items: results.map((u) => ({
        email: u.email,
        name: u.name,
        isAdmin: admins.has(u.email),
        firstLoginAt: u.first_login_at,
        lastLoginAt: u.last_login_at,
        bannedAt: u.banned_at,
        banReason: u.ban_reason,
        liveLeaseCount: u.live_count,
        totalLeaseCount: u.total_count,
      })),
      total: total?.n ?? 0,
      page: query.page,
      pageSize: USERS_PAGE_SIZE,
    };
    return c.json(body);
  })

  // 차단: 세션 전부 삭제 + active/suspended lease 일괄 revoke(사유 user_banned)
  .post("/users/:email/ban", async (c) => {
    const input = await readBody(c, reasonSchema);
    if (input instanceof Response) return input;
    const email = c.req.param("email").trim().toLowerCase();
    if (email === c.var.user.email) return apiError(c, 400, "cannot_ban_self", "자기 자신은 차단할 수 없습니다.");

    const db = c.env.DB;
    const user = await db.prepare(`SELECT email, banned_at FROM users WHERE email = ?`).bind(email).first<{
      email: string;
      banned_at: number | null;
    }>();
    if (!user) return apiError(c, 404, "not_found", "사용자를 찾을 수 없습니다.");
    if (user.banned_at !== null) return apiError(c, 409, "already_banned", "이미 차단된 사용자입니다.");

    // 차단 표시를 먼저 해서 남은 요청도 requireUser에서 즉시 막는다.
    const now = Date.now();
    const [, sessions] = await db.batch([
      db.prepare(`UPDATE users SET banned_at = ?, ban_reason = ? WHERE email = ?`).bind(now, input.reason, email),
      db.prepare(`DELETE FROM sessions WHERE email = ?`).bind(email),
    ]);

    const { results: leases } = await db
      .prepare(`SELECT * FROM leases WHERE owner_email = ? AND status IN ('active','suspended') ORDER BY created_at`)
      .bind(email)
      .all<LeaseRow>();
    const dns = createDnsClient(c.var.config);
    const actor = adminActor(c);
    const revoked: string[] = [];
    const failed: string[] = [];
    for (const lease of leases) {
      try {
        await revokeLease(db, dns, lease, "user_banned", actor);
        revoked.push(lease.name);
      } catch (err) {
        console.error("[admin] ban 중 lease 회수 실패", lease.id, err);
        failed.push(lease.name);
      }
    }

    await writeAudit(db, {
      action: "admin.ban",
      actorEmail: actor.email,
      actorRole: "admin",
      targetEmail: email,
      detail: { reason: input.reason, revokedLeases: revoked, failedLeases: failed, sessionsDeleted: sessions?.meta.changes ?? 0 },
      ...requestMeta(c),
    });
    return c.json({ ok: true, revokedLeases: revoked, failedLeases: failed });
  })

  // 차단 해제 (revoke된 lease는 복구하지 않음)
  .post("/users/:email/unban", async (c) => {
    const input = await readBody(c, optionalReasonSchema);
    if (input instanceof Response) return input;
    const email = c.req.param("email").trim().toLowerCase();
    const db = c.env.DB;
    const user = await db.prepare(`SELECT banned_at, ban_reason FROM users WHERE email = ?`).bind(email).first<{
      banned_at: number | null;
      ban_reason: string | null;
    }>();
    if (!user) return apiError(c, 404, "not_found", "사용자를 찾을 수 없습니다.");
    if (user.banned_at === null) return apiError(c, 409, "not_banned", "차단된 사용자가 아닙니다.");

    await db.batch([
      db.prepare(`UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE email = ?`).bind(email),
      auditStatement(db, {
        action: "admin.unban",
        actorEmail: c.var.user.email,
        actorRole: "admin",
        targetEmail: email,
        detail: { reason: input.reason || null, banReasonBefore: user.ban_reason },
        ...requestMeta(c),
      }),
    ]);
    return c.json({ ok: true });
  })

  // 감사 로그
  .get("/audit-logs", async (c) => {
    const query = z
      .object({
        actor: optionalText,
        action: z.enum(AUDIT_ACTIONS).optional().catch(undefined),
        lease: optionalText,
        from: optionalMs,
        to: optionalMs,
        page,
      })
      .parse(c.req.query());
    const where: string[] = [];
    const binds: unknown[] = [];
    if (query.actor) {
      where.push(`a.actor_email LIKE ? ESCAPE '\\'`);
      binds.push(likeContains(query.actor.toLowerCase()));
    }
    if (query.action) {
      where.push("a.action = ?");
      binds.push(query.action);
    }
    if (query.lease) {
      // lease id 또는 이름
      where.push("(a.lease_id = ? OR l.name = ?)");
      binds.push(query.lease, query.lease.toLowerCase());
    }
    if (query.from !== undefined) {
      where.push("a.at >= ?");
      binds.push(query.from);
    }
    if (query.to !== undefined) {
      where.push("a.at < ?");
      binds.push(query.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM audit_logs a LEFT JOIN leases l ON l.id = a.lease_id ${whereSql}`;
    const db = c.env.DB;
    const total = await db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...binds).first<{ n: number }>();
    const { results } = await db
      .prepare(
        `SELECT a.id, a.at, a.actor_email, a.actor_role, a.action, a.lease_id, l.name AS lease_name,
                a.target_email, a.detail, a.ip
           ${from}
          ORDER BY a.at DESC, a.id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...binds, AUDIT_PAGE_SIZE, (query.page - 1) * AUDIT_PAGE_SIZE)
      .all<{
        id: number;
        at: number;
        actor_email: string | null;
        actor_role: AuditLogItem["actorRole"];
        action: AuditLogItem["action"];
        lease_id: string | null;
        lease_name: string | null;
        target_email: string | null;
        detail: string | null;
        ip: string | null;
      }>();
    const body: Paged<AuditLogItem> = {
      items: results.map((r) => ({
        id: r.id,
        at: r.at,
        actorEmail: r.actor_email,
        actorRole: r.actor_role,
        action: r.action,
        leaseId: r.lease_id,
        leaseName: r.lease_name,
        targetEmail: r.target_email,
        detail: parseDetail(r.detail),
        ip: r.ip,
      })),
      total: total?.n ?? 0,
      page: query.page,
      pageSize: AUDIT_PAGE_SIZE,
    };
    return c.json(body);
  })

  // 최근 reconcile 결과와 끝나지 않은 DNS 작업 기록
  .get("/drift", async (c) => {
    const db = c.env.DB;
    const row = await db.prepare(`SELECT * FROM reconcile_runs ORDER BY at DESC, id DESC LIMIT 1`).first<{
      id: number;
      at: number;
      ok: number;
      drift_count: number;
      items: string;
      error: string | null;
      repaired: string | null;
    }>();
    const { results: ops } = await db.prepare(`SELECT * FROM dns_ops ORDER BY started_at LIMIT 100`).all<DnsOpRow>();
    const lock = await getLock(db, RECOVER_LOCK, RECOVER_LOCK_MS);
    const body: DriftResponse = {
      run: row
        ? {
            id: row.id,
            at: row.at,
            ok: row.ok === 1,
            driftCount: row.drift_count,
            items: (parseDetail(row.items) as DriftItem[] | null) ?? [],
            error: row.error,
            repaired: row.repaired ? (parseDetail(row.repaired) as DriftRepairSummary | null) : null,
          }
        : null,
      pendingOps: ops.map((op) => ({
        id: op.id,
        leaseId: op.lease_id,
        kind: op.kind,
        startedAt: op.started_at,
        attempts: op.attempts,
        lastError: op.last_error,
      })),
      recoverLock: lock,
    };
    return c.json(body);
  })

  // 끝나지 않은 DNS 작업 기록 수동 복구. cron과 겹치지 않게 마지막 실행(cron 포함) 뒤 3분 동안은 거부한다.
  // 시도 상한을 넘은 작업도 다시 시도한다(관리자가 원인을 고친 뒤 누르는 버튼).
  .post("/dns-ops/recover", async (c) => {
    const db = c.env.DB;
    const now = Date.now();
    const lock = await acquireLock(db, RECOVER_LOCK, "manual", RECOVER_LOCK_MS, now);
    if (!lock.ok) {
      const retryAfterSec = Math.max(1, Math.ceil((lock.lock.availableAt - now) / 1000));
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        {
          error: {
            code: "recover_too_soon",
            message: `${lock.lock.trigger === "cron" ? "정기 복구" : "수동 복구"}가 방금 실행됐습니다. ${retryAfterSec}초 후 다시 시도하세요.`,
          },
          retryAfterSec,
        },
        429,
      );
    }
    const r = await recoverPendingOps(db, createDnsClient(c.var.config), now, { retryExhausted: true });
    const body: RecoverOpsResponse = { recovered: r.recovered, failed: r.failed, changedLeases: r.results.filter((x) => changedCount(x) > 0).length };
    await writeAudit(db, { action: "admin.dns_recover", actorEmail: c.var.user.email, actorRole: "admin", detail: body, ...requestMeta(c), at: now });
    return c.json(body);
  });
