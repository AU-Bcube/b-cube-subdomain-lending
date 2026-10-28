import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CRON_DAILY, CRON_HEALTH } from "../worker/cron";
import worker from "../worker/index";
import { call, login, uid } from "./helpers";

async function runCron(cron: string) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), env, ctx);
  await waitOnExecutionContext(ctx);
}

async function expireSession(email: string, expiresAt: number) {
  await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE email = ?`).bind(expiresAt, email).run();
}

async function sessionCount(email: string) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE email = ?`).bind(email).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("cron: 만료 세션 삭제", () => {
  it(`${CRON_DAILY}: 만료된 세션만 삭제하고 유효한 세션은 남긴다`, async () => {
    const expired = await login(`exp-${uid()}@ajou.ac.kr`);
    const valid = await login(`val-${uid()}@ajou.ac.kr`);
    await expireSession(expired.email, Date.now() - 1);

    await runCron(CRON_DAILY);

    expect(await sessionCount(expired.email)).toBe(0);
    expect(await sessionCount(valid.email)).toBe(1);
    expect((await call("/api/me", { session: valid })).status).toBe(200);
  });

  it("다른 cron에서는 세션을 지우지 않는다", async () => {
    const s = await login(`h-${uid()}@ajou.ac.kr`);
    await expireSession(s.email, Date.now() - 1);
    await runCron(CRON_HEALTH);
    expect(await sessionCount(s.email)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 헬스체크, 만료, 드리프트 (SPEC §10)
// ---------------------------------------------------------------------------
import { afterEach, vi } from "vitest";
import { diffRecords, normalizeContent, runReconcile } from "../worker/cron/reconcile";
import { runExpiry } from "../worker/cron/expiry";
import { kstDay, runHealthChecks } from "../worker/cron/health";
import { parseConfig } from "../worker/env";
import { createDnsClient, type CfDnsRecord, type DnsClient } from "../worker/services/cloudflare-dns";
import { checkHealth, detectUnclaimed, DOH_URL, ipProbe, type HealthDeps } from "../worker/services/health";
import type { RecordRow } from "../worker/services/leases";
import { auditFor, createLease, fakeCloudflare, LIVE_DNS } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const ZONE = "b-cube.kr";
const config = () => parseConfig(env);
const dryDns = () => createDnsClient(config());

afterEach(() => vi.restoreAllMocks());

function dohJson(answer: boolean) {
  return Response.json(answer ? { Status: 0, Answer: [{ type: 1, data: "76.76.21.21" }] } : { Status: 3 });
}

/** DoH와 HTTP 응답을 정하는 가짜 의존성 */
function fakeDeps(opts: { resolves: boolean; http?: () => Response; tcp?: (host: string, port: number) => boolean }): HealthDeps & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(input);
      if (input.startsWith(DOH_URL)) return dohJson(opts.resolves);
      if (!opts.http) throw new Error("connection refused");
      return opts.http();
    },
    tcpProbe: async (host, port) => opts.tcp?.(host, port) ?? false,
  };
}

async function lease(id: string) {
  return env.DB.prepare(`SELECT * FROM leases WHERE id = ?`).bind(id).first<{
    status: string;
    status_reason: string | null;
    health_fail_count: number;
    last_health_check_at: number | null;
    last_health_ok_at: number | null;
    suspended_at: number | null;
    ended_at: number | null;
  }>();
}

async function cfIds(leaseId: string) {
  const { results } = await env.DB.prepare(`SELECT cf_record_id FROM records WHERE lease_id = ?`).bind(leaseId).all<{ cf_record_id: string | null }>();
  return results.map((r) => r.cf_record_id);
}

/** 다른 테스트의 lease가 배치(10개)를 차지하지 않도록 기존 active lease의 검사 시각을 미래로 민다. */
async function isolateHealthBatch(now: number) {
  await env.DB.prepare(`UPDATE leases SET last_health_check_at = ? WHERE status = 'active'`).bind(now + 365 * DAY).run();
}

describe("헬스 판정 (services/health.ts)", () => {
  it("CNAME 계열: DoH NXDOMAIN → 실패, HTTP는 요청하지 않음", async () => {
    const deps = fakeDeps({ resolves: false, http: () => new Response("ok") });
    const r = await checkHealth({ targetKind: "cname", fqdn: `a.${ZONE}`, records: [{ type: "CNAME", host: `a.${ZONE}`, content: "gone.example.com" }] }, "live", deps);
    expect(r).toEqual({ ok: false, detail: "DoH: gone.example.com NXDOMAIN" });
    expect(deps.urls.every((u) => u.startsWith(DOH_URL))).toBe(true);
  });

  it("CNAME 계열: 응답이 오면 상태코드와 무관하게 정상, 응답 없음은 실패", async () => {
    const target = { targetKind: "vercel" as const, fqdn: `a.${ZONE}`, records: [{ type: "CNAME", host: `a.${ZONE}`, content: "cname.vercel-dns.com" }] };
    expect((await checkHealth(target, "live", fakeDeps({ resolves: true, http: () => new Response("", { status: 500 }) }))).ok).toBe(true);
    expect((await checkHealth(target, "live", fakeDeps({ resolves: true }))).ok).toBe(false);
  });

  it("target 모드(suspended 재확인)는 DoH만 확인한다", async () => {
    const deps = fakeDeps({ resolves: true });
    const r = await checkHealth({ targetKind: "cname", fqdn: `a.${ZONE}`, records: [{ type: "CNAME", host: `a.${ZONE}`, content: "x.example.com" }] }, "target", deps);
    expect(r.ok).toBe(true);
    expect(deps.urls.some((u) => u.startsWith("https://a."))).toBe(false);
  });

  it("벤더 주인 없음 시그니처", async () => {
    expect(await detectUnclaimed(new Response("", { status: 404, headers: { "x-vercel-error": "DEPLOYMENT_NOT_FOUND" } }))).toBe("Vercel");
    expect(await detectUnclaimed(new Response("", { status: 404, headers: { "x-vercel-error": "NOT_FOUND" } }))).toBe("Vercel");
    expect(await detectUnclaimed(new Response("", { status: 500, headers: { "x-vercel-error": "FUNCTION_INVOCATION_FAILED" } }))).toBeNull();
    expect(await detectUnclaimed(new Response("<h1>404</h1><p>There isn't a GitHub Pages site here.</p>", { status: 404 }))).toBe("GitHub Pages");
    expect(await detectUnclaimed(new Response("Not Found - Request ID: 01ABC", { status: 404, headers: { "x-nf-request-id": "01ABC" } }))).toBe("Netlify");
    expect(await detectUnclaimed(new Response("Not Found - Request ID: 01ABC", { status: 404 }))).toBeNull();
    expect(await detectUnclaimed(new Response("my own 404", { status: 404 }))).toBeNull();
  });

  it("IP 계열: 443 실패 시 80, 하나라도 성공하면 정상", async () => {
    const tried: string[] = [];
    const deps = fakeDeps({ resolves: false, tcp: (h, p) => (tried.push(`${h}:${p}`), h === "3.3.3.3" && p === 80) });
    expect(await ipProbe(deps, ["1.1.1.1", "3.3.3.3"])).toEqual({ ok: true, detail: "TCP 80 연결 성공 (3.3.3.3)" });
    expect(tried).toEqual(["1.1.1.1:443", "1.1.1.1:80", "3.3.3.3:443", "3.3.3.3:80"]);
    expect((await ipProbe(fakeDeps({ resolves: false }), ["1.1.1.1"])).ok).toBe(false);
  });
});

describe("cron: 헬스체크 실패 누적 → suspend → recheck 복구", () => {
  it("하루 1회 실패 누적, 7회째 suspend: Cloudflare 레코드 삭제, DB records 유지", async () => {
    const start = Date.now() + 2 * 365 * DAY;
    await isolateHealthBatch(start + 20 * DAY);
    const name = `hc-${uid()}`;
    const owner = `hc-${uid()}@ajou.ac.kr`;
    const id = await createLease({
      name,
      owner,
      kind: "cname",
      createdAt: start - 10 * DAY,
      expiresAt: start + 100 * DAY,
      records: [{ type: "CNAME", host: `${name}.${ZONE}`, content: "gone.example.com" }],
    });
    const deps = fakeDeps({ resolves: false });
    const dns = dryDns();
    const remove = vi.spyOn(dns, "remove");

    // 매시 cron 중 하루 한 번씩 검사 대상이 되는 상황 (마지막 검사 후 24시간 초과)
    const at = (day: number) => start + day * (DAY + 3600_000);
    for (let day = 0; day < 6; day++) {
      await runHealthChecks(env.DB, dns, config(), at(day), deps);
    }
    expect(await lease(id)).toMatchObject({ status: "active", health_fail_count: 6 });

    // 같은 날 다시 검사해도(24시간 제한을 우회해도) 실패 횟수와 감사 로그는 늘지 않는다
    await env.DB.prepare(`UPDATE leases SET last_health_check_at = NULL WHERE id = ?`).bind(id).run();
    await runHealthChecks(env.DB, dns, config(), at(5) + 60_000, deps);
    expect((await lease(id))?.health_fail_count).toBe(6);
    expect(await auditFor({ action: "system.health_fail", leaseId: id })).toHaveLength(6);

    const result = await runHealthChecks(env.DB, dns, config(), at(6), deps);
    expect(result.suspended).toBe(1);
    expect(await lease(id)).toMatchObject({ status: "suspended", status_reason: "health_check_failed", health_fail_count: 7, suspended_at: at(6) });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await cfIds(id)).toEqual([null]);
    expect((await auditFor({ action: "system.suspend", leaseId: id }))[0]?.detail).toMatchObject({ failCount: 7 });

    // 소유자 재확인: 대상이 다시 응답하면 레코드 재생성 + active
    // (위 검사 시각이 미래로 잡혀 있으므로 재확인 쿨다운에 걸리지 않게 지운다)
    await env.DB.prepare(`UPDATE leases SET last_health_check_at = NULL WHERE id = ?`).bind(id).run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(DOH_URL)) return dohJson(true);
      throw new Error(`unexpected ${url}`);
    });
    const s = await login(owner);
    const res = await call(`/api/leases/${id}/recheck`, { method: "POST", session: s });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reactivated: true });
    expect(await lease(id)).toMatchObject({ status: "active", status_reason: null, health_fail_count: 0, suspended_at: null });
    expect((await cfIds(id))[0]).toMatch(/^dry_/);
    expect(await auditFor({ action: "lease.reactivate", leaseId: id })).toHaveLength(1);
    expect((await auditFor({ action: "lease.recheck", leaseId: id }))[0]?.detail).toMatchObject({ ok: true, status: "suspended" });

    // 1분 안에 다시 누르면 429
    expect((await call(`/api/leases/${id}/recheck`, { method: "POST", session: s })).status).toBe(429);
  });

  it("생성 후 HEALTH_GRACE_DAYS 이내에는 검사하되 실패를 세지 않는다", async () => {
    const now = Date.now() + 3 * 365 * DAY;
    await isolateHealthBatch(now);
    const id = await createLease({ name: `gr-${uid()}`, owner: `gr-${uid()}@ajou.ac.kr`, kind: "cname", createdAt: now - DAY, expiresAt: now + 100 * DAY, records: [{ type: "CNAME", host: `g.${ZONE}`, content: "gone.example.com" }] });
    await runHealthChecks(env.DB, dryDns(), config(), now, fakeDeps({ resolves: false }));
    expect(await lease(id)).toMatchObject({ health_fail_count: 0, last_health_check_at: now });
    expect(await auditFor({ action: "system.health_fail", leaseId: id })).toHaveLength(0);
  });

  it("성공하면 실패 횟수 초기화, 24시간 이내 검사한 lease는 건너뜀, 1회 최대 10개", async () => {
    const now = Date.now() + 4 * 365 * DAY;
    await isolateHealthBatch(now);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await createLease({ name: `ok-${uid()}`, owner: `ok-${uid()}@ajou.ac.kr`, kind: "ip", createdAt: now - 30 * DAY, expiresAt: now + 100 * DAY, failCount: 3, lastHealthCheckAt: i === 0 ? now - 3600_000 : now - 2 * DAY - i, records: [{ type: "A", host: `ok.${ZONE}`, content: "3.3.3.3" }] }));
    }
    const r = await runHealthChecks(env.DB, dryDns(), config(), now, fakeDeps({ resolves: false, tcp: () => true }));
    expect(r.checked).toBe(10);
    expect(await lease(ids[0]!)).toMatchObject({ health_fail_count: 3 }); // 1시간 전 검사 → 건너뜀
    // 가장 오래 전에 검사한 것부터 처리 (i가 클수록 오래됨)
    expect(await lease(ids[11]!)).toMatchObject({ health_fail_count: 0, last_health_ok_at: now });
    expect(await lease(ids[1]!)).toMatchObject({ health_fail_count: 3 });
  });
});

describe("cron: 만료와 이름 보류", () => {
  it("active 만료 → expired + Cloudflare 삭제, suspended로 30일 경과 → expired", async () => {
    const now = Date.now();
    const owner = `ex-${uid()}@ajou.ac.kr`;
    const name = `ex-${uid()}`;
    const expiredId = await createLease({ name, owner, expiresAt: now - 1000, records: [{ type: "A", host: `${name}.${ZONE}`, content: "3.3.3.3" }] });
    const longSuspended = await createLease({ name: `ls-${uid()}`, owner, status: "suspended", suspendedAt: now - 31 * DAY, records: [{ type: "A", host: `x.${ZONE}`, content: "3.3.3.3", cfRecordId: null }] });
    const recentSuspended = await createLease({ name: `rs-${uid()}`, owner, status: "suspended", suspendedAt: now - 5 * DAY });
    const fresh = await createLease({ name: `fr-${uid()}`, owner, expiresAt: now + DAY });

    const dns = dryDns();
    const remove = vi.spyOn(dns, "remove");
    await runExpiry(env.DB, dns, config(), now);

    expect(await lease(expiredId)).toMatchObject({ status: "expired", status_reason: "lease_expired", ended_at: now });
    expect(await cfIds(expiredId)).toEqual([null]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await lease(longSuspended)).toMatchObject({ status: "expired", status_reason: "suspended_too_long" });
    expect((await lease(recentSuspended))?.status).toBe("suspended");
    expect((await lease(fresh))?.status).toBe("active");
    expect((await auditFor({ action: "system.expire", leaseId: expiredId }))[0]?.detail).toMatchObject({ cause: "lease_expired", statusBefore: "active" });

    // 만료된 이름: 보류 기간 동안 원래 소유자만 신청 가능
    const ownerSession = await login(owner);
    const other = await login(`ot-${uid()}@ajou.ac.kr`);
    expect(await (await call(`/api/names/${name}/availability`, { session: other })).json()).toEqual({ available: false, reason: "held" });
    expect(await (await call(`/api/names/${name}/availability`, { session: ownerSession })).json()).toEqual({ available: true });
  });

  it(`${CRON_DAILY} 트리거가 만료 처리를 실행한다`, async () => {
    const id = await createLease({ name: `tr-${uid()}`, owner: `tr-${uid()}@ajou.ac.kr`, expiresAt: Date.now() - 1000 });
    await runCron(CRON_DAILY);
    expect((await lease(id))?.status).toBe("expired");
  });
});

describe("cron: 드리프트 점검", () => {
  const row = (over: Partial<RecordRow>): RecordRow => ({
    id: "r1",
    lease_id: "L1",
    cf_record_id: "cf1",
    type: "A",
    host: `a.${ZONE}`,
    content: "3.3.3.3",
    proxied: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
  });
  const cfRec = (over: Partial<CfDnsRecord>): CfDnsRecord => ({ id: "cf1", type: "A", name: `a.${ZONE}`, content: "3.3.3.3", proxied: false, comment: "bcd:lease=L1", ...over });

  it("cf_only / db_only / mismatch 판정, 같은 값은 드리프트 아님", () => {
    const items = diffRecords(
      [cfRec({}), cfRec({ id: "cf2", content: "9.9.9.9" }), cfRec({ id: "cf9", name: `ghost.${ZONE}`, comment: "bcd:lease=GONE" })],
      [row({}), row({ id: "r2", cf_record_id: "cf2" }), row({ id: "r3", cf_record_id: "cf3" }), row({ id: "r4", cf_record_id: null })],
    );
    expect(items.map((i) => [i.kind, i.recordId ?? i.cfRecordId])).toEqual([
      ["mismatch", "r2"],
      ["db_only", "r3"],
      ["cf_only", "cf9"],
    ]);
    expect(items[2]).toMatchObject({ leaseId: "GONE", host: `ghost.${ZONE}` });
  });

  it("표기 차이는 무시: TXT 따옴표, AAAA 축약, CNAME 끝 점", () => {
    expect(normalizeContent("TXT", '"abc"')).toBe(normalizeContent("TXT", "abc"));
    expect(normalizeContent("AAAA", "2406:da12:0b78:d500:0:0:0:1a")).toBe(normalizeContent("AAAA", "2406:da12:b78:d500::1a"));
    expect(normalizeContent("CNAME", "Cname.Vercel-DNS.com.")).toBe("cname.vercel-dns.com");
  });

  it("안전한 드리프트는 자동 복구하고, Cloudflare에만 있는 레코드는 보고만 한다", async () => {
    const cf = fakeCloudflare(vi.spyOn(globalThis, "fetch"));
    const dns = createDnsClient(parseConfig({ ...env, ...LIVE_DNS } as unknown as Env));
    const owner = `dr-${uid()}@ajou.ac.kr`;
    const put = (id: string, content: string, leaseId: string) =>
      cf.records.set(id, { id, type: "A", name: `d.${ZONE}`, content, proxied: false, comment: `bcd:lease=${leaseId}` });

    // DB에만 있음(대시보드에서 삭제) → 다시 만든다
    const gone = await createLease({ name: `dr-${uid()}`, owner, records: [{ type: "A", host: `d.${ZONE}`, content: "3.3.3.3", cfRecordId: "cf-gone" }] });
    // 내용 다름(대시보드에서 수정) → DB 값으로 되돌린다
    const edited = await createLease({ name: `dr-${uid()}`, owner, records: [{ type: "A", host: `d.${ZONE}`, content: "3.3.3.3", cfRecordId: "cf-edited" }] });
    put("cf-edited", "9.9.9.9", edited);
    // 종료된 lease가 아직 참조하는 레코드 → 지운다
    const ended = await createLease({ name: `dr-${uid()}`, owner, status: "released", endedAt: Date.now(), records: [{ type: "A", host: `d.${ZONE}`, content: "3.3.3.3", cfRecordId: "cf-ended" }] });
    put("cf-ended", "3.3.3.3", ended);
    // comment만 있고 DB에 근거가 없는 레코드 → 건드리지 않는다
    put("cf-orphan", "1.1.1.1", "deleted");

    const at = Date.now() + 5 * 365 * DAY;
    const r = await runReconcile(env.DB, dns, at);
    expect(r.ok).toBe(true);

    const goneRow = (await env.DB.prepare(`SELECT cf_record_id FROM records WHERE lease_id = ?`).bind(gone).first<{ cf_record_id: string }>())!;
    expect(cf.records.get(goneRow.cf_record_id)).toMatchObject({ content: "3.3.3.3", comment: `bcd:lease=${gone}` });
    expect(cf.records.get("cf-edited")?.content).toBe("3.3.3.3");
    expect(cf.records.has("cf-ended")).toBe(false);
    expect(await env.DB.prepare(`SELECT cf_record_id FROM records WHERE lease_id = ?`).bind(ended).first()).toEqual({ cf_record_id: null });
    expect(cf.records.has("cf-orphan")).toBe(true);
    expect(cf.calls).not.toContain("DELETE cf-orphan");

    const run = await env.DB.prepare(`SELECT * FROM reconcile_runs WHERE at = ?`).bind(at).first<{ drift_count: number; items: string; repaired: string }>();
    const items = JSON.parse(run!.items) as Array<{ kind: string; leaseId: string | null }>;
    // 복구 후 다시 비교한 결과만 남는다
    expect(items).toEqual([expect.objectContaining({ kind: "cf_only", leaseId: "deleted" })]);
    expect(run!.drift_count).toBe(1);
    const repaired = JSON.parse(run!.repaired) as { leases: Array<{ leaseId: string }> };
    expect(repaired.leases.map((l) => l.leaseId)).toEqual(expect.arrayContaining([gone, edited, ended]));
    expect(await auditFor({ action: "system.dns_repair", leaseId: gone })).toEqual([
      expect.objectContaining({ actor_role: "system", detail: expect.objectContaining({ recreated: 1 }) }),
    ]);

    const drift = await (await call("/api/admin/drift", { session: await login("t-admin@ajou.ac.kr") })).json();
    expect(drift).toMatchObject({ run: { at, ok: true, driftCount: 1, repaired: { failed: 0 } }, pendingOps: expect.any(Array) });
  });

  it("dry-run에서는 자동 복구하지 않는다", async () => {
    await createLease({ name: `dd-${uid()}`, owner: `dd-${uid()}@ajou.ac.kr`, records: [{ type: "A", host: `d.${ZONE}`, content: "3.3.3.3" }] });
    const at = Date.now() + 5 * 365 * DAY + 1;
    await runReconcile(env.DB, dryDns(), at);
    const run = await env.DB.prepare(`SELECT repaired, error FROM reconcile_runs WHERE at = ?`).bind(at).first();
    expect(run).toMatchObject({ repaired: null, error: expect.stringContaining("DNS_DRY_RUN") });
  });

  it("Cloudflare 조회 실패도 기록한다 (ok=0)", async () => {
    const dns = { ...dryDns(), dryRun: false, listManaged: async () => Promise.reject(new Error("down")) } as DnsClient;
    const at = Date.now() + 6 * 365 * DAY;
    expect(await runReconcile(env.DB, dns, at)).toEqual({ ok: false, driftCount: 0 });
    const run = await env.DB.prepare(`SELECT ok, error FROM reconcile_runs WHERE at = ?`).bind(at).first();
    expect(run).toMatchObject({ ok: 0, error: expect.any(String) });
  });
});

describe("kstDay", () => {
  it("KST 자정을 기준으로 날짜가 바뀐다", () => {
    const kstMidnight = Date.UTC(2026, 9, 26, 15, 0, 0); // 2026-10-27 00:00 KST
    expect(kstDay(kstMidnight - 1)).toBe(kstDay(kstMidnight) - 1);
    expect(kstDay(kstMidnight)).toBe(kstDay(kstMidnight + 23 * 3600_000));
  });
});
