import { Hono, type Context } from "hono";
import type { z } from "zod";
import {
  createLeaseSchema,
  replaceRecordsSchema,
  type LeaseAuditItem,
  type DriftItem,
  type LeaseDetail,
  type LeaseDnsState,
  type LeaseItem,
  type LeasesResponse,
  type NameAvailability,
  type RecheckResponse,
} from "../../shared/schemas";
import type { Config } from "../env";
import { apiError } from "../lib/http";
import { requireUser } from "../middleware/auth";
import { requestMeta } from "../services/audit";
import { createDnsClient, DnsError, type DnsClient } from "../services/cloudflare-dns";
import { queueRepair } from "../services/dns-ops";
import { diffRecords } from "../services/drift";
import {
  checkAvailability,
  createLease,
  fqdnOf,
  getLease,
  getRecordsByLease,
  isRenewable,
  LeaseError,
  LeaseStateError,
  recheckLease,
  releaseLease,
  renewLease,
  replaceLeaseRecords,
  toRecordView,
  type Actor,
  type LeaseRow,
  type RecordRow,
} from "../services/leases";
import type { HonoEnv } from "../types";

export function leaseItem(row: LeaseRow, records: readonly RecordRow[], config: Config, now = Date.now()): LeaseItem {
  return {
    id: row.id,
    name: row.name,
    fqdn: fqdnOf(row.name, config.zoneName),
    targetKind: row.target_kind,
    status: row.status,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    healthFailCount: row.health_fail_count,
    lastHealthCheckAt: row.last_health_check_at,
    lastHealthOkAt: row.last_health_ok_at,
    lastHealthDetail: row.last_health_detail,
    renewable: isRenewable(row, config, now),
    records: records.map(toRecordView),
  };
}

function userActor(c: Context<HonoEnv>): Actor {
  // 자기 lease 작업은 관리자라도 회원 역할로 기록한다.
  return { email: c.var.user.email, role: "user", ...requestMeta(c) };
}

async function readBody<T>(c: Context<HonoEnv>, schema: z.ZodType<T>): Promise<T | Response> {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return apiError(c, 400, "invalid_input", "입력값이 올바르지 않습니다.");
  return parsed.data;
}

/** 서비스 오류를 SPEC §9 에러 형식으로 바꾼다. */
function handleError(c: Context<HonoEnv>, err: unknown): Response {
  if (err instanceof LeaseError) {
    return c.json({ error: { code: err.code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) } }, err.status);
  }
  if (err instanceof LeaseStateError) return apiError(c, 409, "invalid_status", err.message);
  if (err instanceof DnsError) return apiError(c, 502, "dns_error", err.message);
  throw err;
}

/** 자기 lease만 조회한다. 남의 lease는 존재 여부를 숨기기 위해 404. */
async function ownLease(c: Context<HonoEnv>): Promise<LeaseRow | null> {
  const lease = await getLease(c.env.DB, c.req.param("id") ?? "");
  return lease && lease.owner_email === c.var.user.email ? lease : null;
}

/**
 * 상세 화면용 Cloudflare 실제 상태 (SPEC §9). active lease만 조회한다(호출 1회).
 * DB 값과 다르면 복구 작업을 예약한다. 매시 cron이 DB 값으로 맞춘다.
 */
async function dnsStateOf(db: D1Database, dns: DnsClient, lease: LeaseRow, records: readonly RecordRow[]): Promise<LeaseDnsState> {
  const pending = async () => (await db.prepare(`SELECT 1 FROM dns_ops WHERE lease_id = ? LIMIT 1`).bind(lease.id).first()) !== null;
  if (lease.status !== "active") return { checked: false, reason: "not_active", items: [], repairPending: await pending() };
  if (dns.dryRun) return { checked: false, reason: "dry_run", items: [], repairPending: await pending() };
  let items: DriftItem[];
  try {
    items = diffRecords(await dns.listByLease(lease.id), records);
  } catch (err) {
    if (!(err instanceof DnsError)) throw err;
    return { checked: false, reason: "error", items: [], repairPending: await pending() };
  }
  // "Cloudflare에만 있음"은 이 앱이 만들었다는 근거가 DB에 없을 수 있어 복구 대상이 아니다(작업 기록이 있으면 그쪽에서 처리).
  if (items.some((i) => i.kind !== "cf_only")) await queueRepair(db, lease.id);
  return { checked: true, reason: null, items, repairPending: await pending() };
}

const notFound = (c: Context<HonoEnv>) => apiError(c, 404, "not_found", "서브도메인을 찾을 수 없습니다.");

export const nameRoutes = new Hono<HonoEnv>().get("/:name/availability", requireUser, async (c) => {
  const name = c.req.param("name").trim().toLowerCase().slice(0, 64);
  try {
    const body: NameAvailability = await checkAvailability(
      c.env.DB,
      createDnsClient(c.var.config),
      c.var.config,
      name,
      c.var.user.email,
    );
    return c.json(body);
  } catch (err) {
    return handleError(c, err);
  }
});

export const leaseRoutes = new Hono<HonoEnv>()
  .use("*", requireUser)

  .get("/", async (c) => {
    const db = c.env.DB;
    const { results } = await db
      .prepare(`SELECT * FROM leases WHERE owner_email = ? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'suspended' THEN 0 ELSE 1 END, created_at DESC`)
      .bind(c.var.user.email)
      .all<LeaseRow>();
    const records = await getRecordsByLease(db, results.map((r) => r.id));
    const now = Date.now();
    const body: LeasesResponse = {
      items: results.map((row) => leaseItem(row, records.get(row.id) ?? [], c.var.config, now)),
      renewWindowDays: c.var.config.renewWindowDays,
    };
    return c.json(body);
  })

  .get("/:id", async (c) => {
    const lease = await ownLease(c);
    if (!lease) return notFound(c);
    const db = c.env.DB;
    const records = (await getRecordsByLease(db, [lease.id])).get(lease.id) ?? [];
    const { results } = await db
      .prepare(`SELECT id, at, actor_role, action, detail FROM audit_logs WHERE lease_id = ? ORDER BY at DESC, id DESC LIMIT 100`)
      .bind(lease.id)
      .all<{ id: number; at: number; actor_role: LeaseAuditItem["actorRole"]; action: LeaseAuditItem["action"]; detail: string | null }>();
    const body: LeaseDetail = {
      ...leaseItem(lease, records, c.var.config),
      dnsState: await dnsStateOf(db, createDnsClient(c.var.config), lease, records),
      auditLogs: results.map((r) => ({
        id: r.id,
        at: r.at,
        actorRole: r.actor_role,
        action: r.action,
        detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
      })),
    };
    return c.json(body);
  })

  .post("/", async (c) => {
    const input = await readBody(c, createLeaseSchema);
    if (input instanceof Response) return input;
    const db = c.env.DB;
    try {
      const lease = await createLease(db, createDnsClient(c.var.config), c.var.config, c.var.user.email, input, userActor(c));
      const records = (await getRecordsByLease(db, [lease.id])).get(lease.id) ?? [];
      return c.json(leaseItem(lease, records, c.var.config), 201);
    } catch (err) {
      return handleError(c, err);
    }
  })

  .put("/:id/records", async (c) => {
    const input = await readBody(c, replaceRecordsSchema);
    if (input instanceof Response) return input;
    const lease = await ownLease(c);
    if (!lease) return notFound(c);
    try {
      const result = await replaceLeaseRecords(c.env.DB, createDnsClient(c.var.config), c.var.config, lease, input.records, userActor(c));
      return c.json({ ok: true, ...result });
    } catch (err) {
      return handleError(c, err);
    }
  })

  .post("/:id/renew", async (c) => {
    const lease = await ownLease(c);
    if (!lease) return notFound(c);
    try {
      const expiresAt = await renewLease(c.env.DB, c.var.config, lease, userActor(c));
      return c.json({ ok: true, expiresAt });
    } catch (err) {
      return handleError(c, err);
    }
  })

  .post("/:id/recheck", async (c) => {
    const lease = await ownLease(c);
    if (!lease) return notFound(c);
    try {
      const { result, reactivated } = await recheckLease(c.env.DB, createDnsClient(c.var.config), c.var.config, lease, userActor(c));
      const body: RecheckResponse = { ok: result.ok, detail: result.detail, reactivated };
      return c.json(body);
    } catch (err) {
      return handleError(c, err);
    }
  })

  .delete("/:id", async (c) => {
    const lease = await ownLease(c);
    if (!lease) return notFound(c);
    try {
      await releaseLease(c.env.DB, createDnsClient(c.var.config), lease, userActor(c));
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err);
    }
  });
