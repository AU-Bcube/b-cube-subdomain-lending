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
  type DriftResponse,
  type RecoverOpsResponse,
  type Paged,
} from "../../shared/schemas";
import { NO_ID, type AuditRow, type UserRow } from "../db";
import { apiError } from "../lib/http";
import { requireAdmin, requireUser } from "../middleware/auth";
import { deleteAccount } from "../services/account";
import { auditStatement, requestMeta, writeAudit } from "../services/audit";
import { createDnsClient, DnsError } from "../services/cloudflare-dns";
import { acquireLock, getLock, RECOVER_LOCK, RECOVER_LOCK_MS } from "../services/job-lock";
import { changedCount, recoverPendingOps } from "../services/repair";
import {
  getLease,
  getRecordsByLease,
  LeaseError,
  LeaseStateError,
  revokeLease,
  toRecordView,
  type Actor,
  type LeaseRow,
} from "../services/leases";
import type { Filter } from "mongodb";
import type { HonoEnv } from "../types";

const LEASES_PAGE_SIZE = 20;
const USERS_PAGE_SIZE = 20;
const AUDIT_PAGE_SIZE = 25;

const page = z.coerce.number().int().min(1).max(100_000).catch(1);
const optionalText = z.string().trim().max(200).optional().catch(undefined);
const optionalMs = z.coerce.number().int().min(0).optional().catch(undefined);

/** 부분 일치 검색(대소문자 무시). 검색어의 정규식 문자는 이스케이프한다. */
function contains(value: string) {
  return { $regex: value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
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

export const adminRoutes = new Hono<HonoEnv>()
  .use("*", requireUser, requireAdmin)

  // 전체 lease (이름/소유자 검색)
  .get("/leases", async (c) => {
    const query = z
      .object({ status: z.enum(LEASE_STATUSES).optional().catch(undefined), q: optionalText, page })
      .parse(c.req.query());
    const filter: Filter<LeaseRow> = {};
    if (query.status) filter.status = query.status;
    if (query.q) filter.$or = [{ name: contains(query.q) }, { owner_email: contains(query.q) }];
    const db = c.env.DB;
    const total = await db.leases.countDocuments(filter);
    const results = await db.leases
      .find(filter, NO_ID)
      .sort({ created_at: -1, id: 1 })
      .skip((query.page - 1) * LEASES_PAGE_SIZE)
      .limit(LEASES_PAGE_SIZE)
      .toArray();
    const records = await getRecordsByLease(db, results.map((r) => r.id));
    const body: Paged<AdminLeaseItem> = {
      items: results.map((row) => leaseItem(row, (records.get(row.id) ?? []).map(toRecordView))),
      total,
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
    const filter: Filter<UserRow> = {};
    if (query.q) filter.$or = [{ email: contains(query.q) }, { name: contains(query.q) }];
    if (query.banned === "true") filter.banned_at = { $ne: null };
    if (query.banned === "false") filter.banned_at = null;
    const db = c.env.DB;
    const total = await db.users.countDocuments(filter);
    const results = await db.users
      .find(filter)
      .sort({ last_login_at: -1, email: 1 })
      .skip((query.page - 1) * USERS_PAGE_SIZE)
      .limit(USERS_PAGE_SIZE)
      .toArray();
    // 보유 lease 수
    const owned = await db.leases.find({ owner_email: { $in: results.map((u) => u.email) } }, { projection: { _id: 0, owner_email: 1, status: 1 } }).toArray();
    const countOf = (email: string, live: boolean) =>
      owned.filter((l) => l.owner_email === email && (!live || l.status === "active" || l.status === "suspended")).length;
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
        liveLeaseCount: countOf(u.email, true),
        totalLeaseCount: countOf(u.email, false),
      })),
      total,
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
    const user = await db.users.findOne({ email });
    if (!user) return apiError(c, 404, "not_found", "사용자를 찾을 수 없습니다.");
    if (user.banned_at !== null) return apiError(c, 409, "already_banned", "이미 차단된 사용자입니다.");

    // 차단 표시를 먼저 해서 남은 요청도 requireUser에서 즉시 막는다.
    const now = Date.now();
    const [, sessions] = await db.batch([
      db.write((session) => db.users.updateOne({ email }, { $set: { banned_at: now, ban_reason: input.reason } }, { session })),
      db.write((session) => db.sessions.deleteMany({ email }, { session })),
    ]);

    const leases = await db.leases
      .find({ owner_email: email, status: { $in: ["active", "suspended"] } }, NO_ID)
      .sort({ created_at: 1 })
      .toArray();
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
      detail: { reason: input.reason, revokedLeases: revoked, failedLeases: failed, sessionsDeleted: sessions ?? 0 },
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
    const user = await db.users.findOne({ email });
    if (!user) return apiError(c, 404, "not_found", "사용자를 찾을 수 없습니다.");
    if (user.banned_at === null) return apiError(c, 409, "not_banned", "차단된 사용자가 아닙니다.");

    await db.batch([
      db.write((session) => db.users.updateOne({ email }, { $set: { banned_at: null, ban_reason: null } }, { session })),
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

  // 회원 정보 삭제: 남은 lease를 회수하고 사용자, 세션, 레코드를 지운다. 감사 로그는 남는다.
  // 차단된 사용자는 지우면 차단 기록이 사라져 다시 가입할 수 있으므로 먼저 차단을 해제해야 한다.
  .post("/users/:email/delete", async (c) => {
    const input = await readBody(c, reasonSchema);
    if (input instanceof Response) return input;
    const email = c.req.param("email").trim().toLowerCase();
    if (email === c.var.user.email) return apiError(c, 400, "cannot_delete_self", "자기 자신은 삭제할 수 없습니다. 회원 탈퇴를 이용하세요.");

    const db = c.env.DB;
    const user = await db.users.findOne({ email });
    if (!user) return apiError(c, 404, "not_found", "사용자를 찾을 수 없습니다.");
    if (user.banned_at !== null) return apiError(c, 409, "user_banned", "차단된 사용자입니다. 차단을 해제한 뒤 삭제하세요.");

    const dns = createDnsClient(c.var.config);
    const actor = adminActor(c);
    try {
      await deleteAccount(db, dns, email, {
        action: "admin.delete_user",
        actor,
        reason: input.reason,
        endLease: (lease) => revokeLease(db, dns, lease, "user_deleted", actor),
      });
    } catch (err) {
      if (err instanceof LeaseError) return apiError(c, 409, err.code, err.message);
      if (err instanceof LeaseStateError) return apiError(c, 409, "invalid_status", err.message);
      if (err instanceof DnsError) return apiError(c, 502, "dns_error", err.message);
      throw err;
    }
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
    const db = c.env.DB;
    const filter: Filter<AuditRow> = {};
    if (query.actor) filter.actor_email = contains(query.actor);
    if (query.action) filter.action = query.action;
    if (query.lease) {
      // lease id 또는 이름
      const named = await db.leases.find({ name: query.lease.toLowerCase() }, { projection: { _id: 0, id: 1 } }).toArray();
      filter.lease_id = { $in: [query.lease, ...named.map((l) => l.id)] };
    }
    if (query.from !== undefined || query.to !== undefined) {
      filter.at = { ...(query.from !== undefined ? { $gte: query.from } : {}), ...(query.to !== undefined ? { $lt: query.to } : {}) };
    }
    const total = await db.auditLogs.countDocuments(filter);
    const results = await db.auditLogs
      .find(filter)
      .sort({ at: -1, _id: -1 })
      .skip((query.page - 1) * AUDIT_PAGE_SIZE)
      .limit(AUDIT_PAGE_SIZE)
      .toArray();
    const leaseIds = [...new Set(results.flatMap((r) => (r.lease_id ? [r.lease_id] : [])))];
    const leaseNames = new Map(
      (await db.leases.find({ id: { $in: leaseIds } }, { projection: { _id: 0, id: 1, name: 1 } }).toArray()).map((l) => [l.id, l.name]),
    );
    const body: Paged<AuditLogItem> = {
      items: results.map((r) => ({
        id: r._id.toHexString(),
        at: r.at,
        actorEmail: r.actor_email,
        actorRole: r.actor_role,
        action: r.action,
        leaseId: r.lease_id,
        leaseName: r.lease_id ? (leaseNames.get(r.lease_id) ?? null) : null,
        targetEmail: r.target_email,
        detail: r.detail,
        ip: r.ip,
      })),
      total,
      page: query.page,
      pageSize: AUDIT_PAGE_SIZE,
    };
    return c.json(body);
  })

  // 최근 reconcile 결과와 끝나지 않은 DNS 작업 기록
  .get("/drift", async (c) => {
    const db = c.env.DB;
    const row = await db.reconcileRuns.findOne({}, { sort: { at: -1, _id: -1 } });
    const ops = await db.dnsOps.find({}, NO_ID).sort({ started_at: 1 }).limit(100).toArray();
    const lock = await getLock(db, RECOVER_LOCK, RECOVER_LOCK_MS);
    const body: DriftResponse = {
      run: row
        ? {
            id: row._id.toHexString(),
            at: row.at,
            ok: row.ok === 1,
            driftCount: row.drift_count,
            items: row.items,
            error: row.error,
            repaired: row.repaired,
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
