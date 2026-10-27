/**
 * 통합 테스트 픽스처. 로컬 시드(scripts/seed.ts)와 독립적이다.
 */
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import worker from "../worker/index";
import type { LeaseStatus, RecordType, TargetKind } from "../shared/rules";
import { randomToken, sha256Hex } from "../worker/auth/crypto";

export const ORIGIN = "http://localhost:5173";
export const ADMIN_EMAIL = "t-admin@ajou.ac.kr";
const DAY = 24 * 60 * 60 * 1000;

/** 테스트 간 충돌을 피하기 위한 고유 접미사 */
export function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

export async function createUser(email: string, opts: { banned?: boolean; name?: string } = {}): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (email, google_sub, name, first_login_at, last_login_at, banned_at, ban_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(email, `sub-${email}`, opts.name ?? null, now, now, opts.banned ? now : null, opts.banned ? "테스트 차단" : null)
    .run();
}

export interface Session {
  email: string;
  cookie: string;
  csrf: string;
}

/** 사용자를 만들고(없으면) 세션을 직접 넣는다. */
export async function login(email: string): Promise<Session> {
  const exists = await env.DB.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first();
  if (!exists) await createUser(email);
  const token = randomToken(32);
  const csrf = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO sessions (id_hash, email, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(await sha256Hex(token), email, csrf, now, now + 7 * DAY)
    .run();
  return { email, cookie: `bcd_session=${token}`, csrf };
}

export type WorkerFetch = (req: Request) => Promise<Response>;

/** env 값을 바꿔 Worker를 직접 호출한다(설정별 라우트 등록·안전장치·live DNS 모드 확인용). */
export function workerWith(overrides: Partial<Record<keyof Env, string>>): WorkerFetch {
  const variant = { ...env, ...overrides } as unknown as Env;
  return async (req: Request) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, variant, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

export async function call(
  path: string,
  opts: {
    method?: string;
    session?: Session;
    body?: unknown;
    origin?: string | null;
    csrf?: string | null;
    via?: WorkerFetch;
  } = {},
): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (opts.session) headers.set("Cookie", opts.session.cookie);
  if (method !== "GET") {
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    if (origin !== null) headers.set("Origin", origin);
    const csrf = opts.csrf === undefined ? opts.session?.csrf : opts.csrf;
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  const req = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  return opts.via ? opts.via(req) : SELF.fetch(req);
}

export interface FixtureRecord {
  type: RecordType;
  host: string;
  content: string;
  proxied?: boolean;
  /** null이면 Cloudflare에 없는 레코드 */
  cfRecordId?: string | null;
}

export async function createLease(opts: {
  name: string;
  owner: string;
  status?: LeaseStatus;
  kind?: TargetKind;
  createdAt?: number;
  expiresAt?: number;
  endedAt?: number | null;
  suspendedAt?: number | null;
  failCount?: number;
  lastHealthCheckAt?: number | null;
  records?: FixtureRecord[];
}): Promise<string> {
  const owner = await env.DB.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(opts.owner).first();
  if (!owner) await createUser(opts.owner);
  const id = crypto.randomUUID();
  const now = opts.createdAt ?? Date.now();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO leases (id, name, owner_email, target_kind, status, created_at, expires_at, ended_at, suspended_at,
                           health_fail_count, last_health_check_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      opts.name,
      opts.owner,
      opts.kind ?? "ip",
      opts.status ?? "active",
      now,
      opts.expiresAt ?? now + 180 * DAY,
      opts.endedAt ?? null,
      opts.suspendedAt ?? null,
      opts.failCount ?? 0,
      opts.lastHealthCheckAt ?? null,
    ),
    ...(opts.records ?? []).map((r, i) =>
      env.DB.prepare(
        `INSERT INTO records (id, lease_id, cf_record_id, type, host, content, proxied, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `${id}-r${i}`,
        id,
        r.cfRecordId === undefined ? `dry_${uid()}` : r.cfRecordId,
        r.type,
        r.host,
        r.content,
        r.proxied ? 1 : 0,
        now + i,
        now + i,
      ),
    ),
  ];
  await env.DB.batch(stmts);
  return id;
}

export async function auditFor(filter: { action: string; leaseId?: string; targetEmail?: string }) {
  const where = ["action = ?"];
  const binds: unknown[] = [filter.action];
  if (filter.leaseId) {
    where.push("lease_id = ?");
    binds.push(filter.leaseId);
  }
  if (filter.targetEmail) {
    where.push("target_email = ?");
    binds.push(filter.targetEmail);
  }
  const { results } = await env.DB.prepare(`SELECT * FROM audit_logs WHERE ${where.join(" AND ")} ORDER BY id`)
    .bind(...binds)
    .all<{ actor_email: string | null; actor_role: string; detail: string | null; lease_id: string | null }>();
  return results.map((r) => ({ ...r, detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null }));
}

// ---------------------------------------------------------------------------
// 가짜 Cloudflare DNS API (live 모드 테스트용). globalThis.fetch를 가로챈다.
// ---------------------------------------------------------------------------

export const LIVE_DNS = { DNS_DRY_RUN: "false", CF_ZONE_ID: "zone-test", CF_API_TOKEN: "token-test" } as const;

export interface FakeCfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  comment: string | null;
}

export interface FakeCloudflare {
  records: Map<string, FakeCfRecord>;
  /** "POST", "PATCH a.b-cube.kr", "DELETE <id>", "GET name=..." 형식의 호출 기록 */
  calls: string[];
  /** true를 돌려주면 해당 호출을 500으로 실패시킨다 */
  failWhen: ((method: string, record: Partial<FakeCfRecord>) => boolean) | null;
}

const CF_BASE = "https://api.cloudflare.com/client/v4/zones/zone-test/dns_records";

export function fakeCloudflare(fetchSpy: { mockImplementation: (fn: typeof fetch) => unknown }): FakeCloudflare {
  const state: FakeCloudflare = { records: new Map(), calls: [], failWhen: null };
  let seq = 0;
  const realFetch = globalThis.fetch;
  const ok = (result: unknown, extra: Record<string, unknown> = {}) => Response.json({ success: true, errors: [], result, ...extra });
  const fail = () => Response.json({ success: false, errors: [{ code: 1000, message: "boom" }], result: null }, { status: 500 });

  fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(CF_BASE)) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const id = decodeURIComponent(u.pathname.slice(new URL(CF_BASE).pathname.length + 1));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Partial<FakeCfRecord>) : {};

    if (method === "GET") {
      state.calls.push(`GET ${u.searchParams.toString().replace(/&?(page|per_page)=\d+/g, "")}`);
      const name = u.searchParams.get("name");
      const prefix = u.searchParams.get("comment.startswith");
      const list = [...state.records.values()].filter(
        (r) => (name === null || r.name === name) && (prefix === null || (r.comment ?? "").startsWith(prefix)),
      );
      return ok(list, { result_info: { page: 1, total_pages: 1 } });
    }
    if (method === "POST") {
      state.calls.push(`POST ${body.type} ${body.name} ${body.content}`);
      if (state.failWhen?.("POST", body)) return fail();
      const rec = { id: `cf-${++seq}`, type: body.type!, name: body.name!, content: body.content!, proxied: body.proxied === true, comment: body.comment ?? null };
      state.records.set(rec.id, rec);
      return ok(rec);
    }
    if (method === "PATCH") {
      state.calls.push(`PATCH ${id} ${body.content}`);
      if (state.failWhen?.("PATCH", body)) return fail();
      const rec = state.records.get(id);
      if (!rec) return Response.json({ success: false, errors: [{ code: 81044, message: "not found" }], result: null }, { status: 404 });
      Object.assign(rec, { content: body.content, proxied: body.proxied === true });
      return ok(rec);
    }
    if (method === "DELETE") {
      state.calls.push(`DELETE ${id}`);
      if (state.failWhen?.("DELETE", state.records.get(id) ?? {})) return fail();
      if (!state.records.delete(id)) return Response.json({ success: false, errors: [], result: null }, { status: 404 });
      return ok({ id });
    }
    return fail();
  }) as typeof fetch);
  return state;
}
