/**
 * 통합 테스트 픽스처. 로컬 시드(scripts/seed.ts)와 독립적이다.
 */
import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import worker from "../worker/index";
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
