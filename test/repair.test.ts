import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriftResponse, LeaseDetail, LeaseItem } from "../shared/schemas";
import { handleScheduled } from "../worker/index";
import { parseConfig } from "../worker/env";
import { createDnsClient, type DnsClient } from "../worker/services/cloudflare-dns";
import { OP_MAX_ATTEMPTS, OP_STALE_MS, queueRepair } from "../worker/services/dns-ops";
import { RECOVER_LOCK_MS } from "../worker/services/job-lock";
import { recoverPendingOps, repairLease } from "../worker/services/repair";
import { env } from "./env";
import { ADMIN_EMAIL, auditFor, call, createLease, fakeCloudflare, LIVE_DNS, login, uid, workerWith, type FakeCloudflare, type Session } from "./helpers";

const ZONE = "b-cube.kr";
const fq = (name: string) => `${name}.${ZONE}`;
const nm = () => `rp-${uid()}`;
const via = workerWith(LIVE_DNS);
/** 작업 기록이 cron 복구 대상이 되는 시각 */
const later = () => Date.now() + OP_STALE_MS + 1000;

async function ops(leaseId: string) {
  return env.DB.dnsOps.find({ lease_id: leaseId }).toArray();
}

async function cfIds(leaseId: string) {
  const results = await env.DB.records.find({ lease_id: leaseId }).sort({ created_at: 1, id: 1 }).toArray();
  return results.map((r) => r.cf_record_id);
}

afterEach(() => vi.restoreAllMocks());


describe("DNS 작업 기록과 복구 (live 모드)", () => {
  let cf: FakeCloudflare;
  let dns: DnsClient;
  let s: Session;

  beforeEach(async () => {
    cf = fakeCloudflare(vi.spyOn(globalThis, "fetch"));
    dns = createDnsClient(parseConfig({ ...env, ...LIVE_DNS } ));
    s = await login(`rp-${uid()}@ajou.ac.kr`);
  });

  async function create(name: string, records: unknown[]) {
    const res = await call("/api/leases", { method: "POST", session: s, via, body: { name, targetKind: "ip", records } });
    expect(res.status).toBe(201);
    return (await res.json()) as LeaseItem;
  }

  it("성공한 작업은 기록을 남기지 않는다", async () => {
    const name = nm();
    const lease = await create(name, [{ type: "A", host: fq(name), content: "3.3.3.3" }]);
    await call(`/api/leases/${lease.id}/records`, { method: "PUT", session: s, via, body: { records: [{ type: "A", host: fq(name), content: "4.4.4.4" }] } });
    await call(`/api/leases/${lease.id}`, { method: "DELETE", session: s, via });
    expect(await ops(lease.id)).toEqual([]);
  });

  it("교체 후 기존 레코드 삭제 실패 → 기록에 남고, cron 복구가 지운다", async () => {
    const name = nm();
    const lease = await create(name, [{ type: "A", host: fq(name), content: "3.3.3.3" }]);
    const [oldId] = await cfIds(lease.id);
    cf.failWhen = (method) => method === "DELETE";
    const res = await call(`/api/leases/${lease.id}/records`, { method: "PUT", session: s, via, body: { records: [{ type: "A", host: fq(name), content: "4.4.4.4" }] } });
    expect(res.status).toBe(200);
    expect(cf.records.has(oldId!)).toBe(true);
    expect((await ops(lease.id)).map((o) => [o.kind, o.cf_ids])).toEqual([["replace", [oldId]]]);

    cf.failWhen = null;
    // 진행 중일 수 있는 작업은 건드리지 않는다
    expect((await recoverPendingOps(env.DB, dns)).recovered).toBe(0);
    await recoverPendingOps(env.DB, dns, later());
    expect(cf.records.has(oldId!)).toBe(false);
    expect([...cf.records.values()].filter((r) => r.comment === `bcd:lease=${lease.id}`).map((r) => r.content)).toEqual(["4.4.4.4"]);
    expect(await ops(lease.id)).toEqual([]);
  });

  it("생성 롤백 실패 → 만든 레코드 id가 기록에 남고, lease가 없으므로 복구가 지운다", async () => {
    const name = nm();
    cf.failWhen = (method, rec) => (method === "POST" && rec.content === "4.4.4.4") || method === "DELETE";
    const res = await call("/api/leases", {
      method: "POST",
      session: s,
      via,
      body: { name, targetKind: "ip", records: [{ type: "A", host: fq(name), content: "3.3.3.3" }, { type: "A", host: fq(name), content: "4.4.4.4" }] },
    });
    expect(res.status).toBe(502);
    const leftover = [...cf.records.values()].filter((r) => r.name === fq(name));
    expect(leftover).toHaveLength(1);
    const leaseId = leftover[0]!.comment!.slice("bcd:lease=".length);
    expect(await env.DB.leases.findOne({ id: leaseId })).toBeNull();
    expect((await ops(leaseId)).map((o) => o.cf_ids)).toEqual([[leftover[0]!.id]]);

    cf.failWhen = null;
    await recoverPendingOps(env.DB, dns, later());
    expect([...cf.records.values()].filter((r) => r.name === fq(name))).toEqual([]);
    expect(await ops(leaseId)).toEqual([]);
  });

  it("반납 도중 실패 → lease는 active로 남고, 복구가 DB 기준으로 레코드를 다시 만든다", async () => {
    const name = nm();
    const lease = await create(name, [
      { type: "A", host: fq(name), content: "3.3.3.3" },
      { type: "A", host: fq(name), content: "4.4.4.4" },
    ]);
    const [, second] = await cfIds(lease.id);
    cf.failWhen = (method, rec) => method === "DELETE" && rec.id === second;
    expect((await call(`/api/leases/${lease.id}`, { method: "DELETE", session: s, via })).status).toBe(502);
    expect((await cfIds(lease.id))[0]).toBeNull();
    expect((await ops(lease.id)).map((o) => o.kind)).toEqual(["release"]);

    cf.failWhen = null;
    await recoverPendingOps(env.DB, dns, later());
    const ids = await cfIds(lease.id);
    expect(ids.every((id) => id !== null && cf.records.has(id))).toBe(true);
    expect(ids.map((id) => cf.records.get(id!)!.content)).toEqual(["3.3.3.3", "4.4.4.4"]);
    // 다시 반납하면 정상 종료
    expect((await call(`/api/leases/${lease.id}`, { method: "DELETE", session: s, via })).status).toBe(200);
    expect([...cf.records.values()].filter((r) => r.name === fq(name))).toEqual([]);
  });

  it("복구 실패는 시도 횟수와 오류를 남기고, 상한을 넘으면 더 시도하지 않는다", async () => {
    const leaseId = await createLease({ name: nm(), owner: s.email, records: [{ type: "A", host: fq("x"), content: "3.3.3.3", cfRecordId: "cf-missing" }] });
    await env.DB.dnsOps.insertOne({ id: uid(), lease_id: leaseId, kind: "repair", cf_ids: [], started_at: 0, attempts: 0, last_error: null });
    cf.failWhen = (method) => method === "POST";
    for (let i = 0; i < OP_MAX_ATTEMPTS + 1; i++) await recoverPendingOps(env.DB, dns, later());
    const [op] = await ops(leaseId);
    expect(op).toMatchObject({ attempts: OP_MAX_ATTEMPTS, last_error: expect.any(String) });
    expect(cf.calls.filter((c) => c.startsWith("POST"))).toHaveLength(OP_MAX_ATTEMPTS);
  });

  it("DB에 근거가 없는 레코드는 comment가 같아도 지우지 않는다", async () => {
    const name = nm();
    const lease = await create(name, [{ type: "A", host: fq(name), content: "3.3.3.3" }]);
    cf.records.set("hand-made", { id: "hand-made", type: "TXT", name: fq(name), content: "x", proxied: false, comment: `bcd:lease=${lease.id}` });
    await env.DB.leases.updateOne({ id: lease.id }, { $set: { status: "revoked" } });
    const r = await repairLease(env.DB, dns, lease.id);
    expect(r.removed).toBe(1);
    expect(cf.records.has("hand-made")).toBe(true);
  });

  it("상세 화면: Cloudflare 실제 값과 다르면 알려주고 복구를 예약한다", async () => {
    const name = nm();
    const lease = await create(name, [{ type: "A", host: fq(name), content: "3.3.3.3" }]);
    const fresh = (await (await call(`/api/leases/${lease.id}`, { session: s, via })).json()) as LeaseDetail;
    expect(fresh.dnsState).toEqual({ checked: true, reason: null, items: [], repairPending: false });

    const [cfId] = await cfIds(lease.id);
    cf.records.get(cfId!)!.content = "9.9.9.9";
    const drifted = (await (await call(`/api/leases/${lease.id}`, { session: s, via })).json()) as LeaseDetail;
    expect(drifted.dnsState).toMatchObject({ checked: true, repairPending: true, items: [{ kind: "mismatch", dbContent: "3.3.3.3", cfContent: "9.9.9.9" }] });
    expect((await ops(lease.id)).map((o) => o.kind)).toEqual(["repair"]);

    await recoverPendingOps(env.DB, dns, later());
    expect(cf.records.get(cfId!)!.content).toBe("3.3.3.3");
  });

  it("상세 화면: Cloudflare 조회 실패는 화면을 막지 않는다", async () => {
    const name = nm();
    const lease = await create(name, [{ type: "A", host: fq(name), content: "3.3.3.3" }]);
    cf.failWhen = (method) => method === "GET";
    const res = await call(`/api/leases/${lease.id}`, { session: s, via });
    expect(res.status).toBe(200);
    expect(((await res.json()) as LeaseDetail).dnsState).toMatchObject({ checked: false, reason: "error" });
  });
});

describe("dry-run", () => {
  it("상세 화면은 Cloudflare를 조회하지 않는다", async () => {
    const s = await login(`rd-${uid()}@ajou.ac.kr`);
    const leaseId = await createLease({ name: nm(), owner: s.email, records: [{ type: "A", host: fq("x"), content: "3.3.3.3" }] });
    const body = (await (await call(`/api/leases/${leaseId}`, { session: s })).json()) as LeaseDetail;
    expect(body.dnsState).toEqual({ checked: false, reason: "dry_run", items: [], repairPending: false });
  });
});

describe("수동 복구 (POST /api/admin/dns-ops/recover)", () => {
  let cf: FakeCloudflare;
  let admin: Session;

  beforeEach(async () => {
    cf = fakeCloudflare(vi.spyOn(globalThis, "fetch"));
    admin = await login(ADMIN_EMAIL);
    await env.DB.jobLocks.deleteMany({});
    await env.DB.dnsOps.deleteMany({});
  });

  const recover = () => call("/api/admin/dns-ops/recover", { method: "POST", session: admin, via });

  async function missingRecordLease() {
    const name = nm();
    // 헬스체크 대상이 되지 않게 방금 검사한 것으로 둔다(cron 테스트에서 외부 요청 방지).
    return createLease({
      name,
      owner: `rm-${uid()}@ajou.ac.kr`,
      lastHealthCheckAt: Date.now(),
      records: [{ type: "A", host: fq(name), content: "3.3.3.3", cfRecordId: `cf-${uid()}` }],
    });
  }

  it("시도 상한을 넘은 작업과 복구 예약을 바로 처리하고 감사 로그를 남긴다", async () => {
    const exhausted = await missingRecordLease();
    await env.DB.dnsOps.insertOne({ id: uid(), lease_id: exhausted, kind: "replace", cf_ids: [], started_at: 0, attempts: OP_MAX_ATTEMPTS, last_error: null });
    const queued = await missingRecordLease();
    await queueRepair(env.DB, queued);

    const res = await recover();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recovered: 2, failed: 0, changedLeases: 2 });
    expect(await ops(exhausted)).toEqual([]);
    expect(await ops(queued)).toEqual([]);
    expect([...cf.records.values()].map((r) => r.comment)).toEqual(expect.arrayContaining([`bcd:lease=${exhausted}`, `bcd:lease=${queued}`]));
    expect(await auditFor({ action: "admin.dns_recover" })).toContainEqual(
      expect.objectContaining({ actor_email: ADMIN_EMAIL, detail: { recovered: 2, failed: 0, changedLeases: 2 } }),
    );
  });

  it("시작한 지 10분이 안 된 작업은 진행 중일 수 있어 건너뛴다", async () => {
    const leaseId = await missingRecordLease();
    await env.DB.dnsOps.insertOne({ id: uid(), lease_id: leaseId, kind: "replace", cf_ids: [], started_at: Date.now(), attempts: 0, last_error: null });
    expect(await (await recover()).json()).toMatchObject({ recovered: 0 });
    expect(await ops(leaseId)).toHaveLength(1);
  });

  it("마지막 실행 뒤 3분 동안은 다시 실행할 수 없다 (429, Retry-After)", async () => {
    expect((await recover()).status).toBe(200);
    const again = await recover();
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(170);
    expect(await again.json()).toMatchObject({ error: { code: "recover_too_soon" }, retryAfterSec: expect.any(Number) });

    const drift = (await (await call("/api/admin/drift", { session: admin })).json()) as DriftResponse;
    expect(drift.recoverLock).toMatchObject({ trigger: "manual", availableAt: expect.any(Number) });

    // 3분이 지나면 다시 가능
    await env.DB.jobLocks.updateMany({}, { $inc: { started_at: -RECOVER_LOCK_MS } });
    expect((await recover()).status).toBe(200);
  });

  it("cron 실행 직후에는 수동 복구를 막고, 수동 복구 직후의 cron은 작업 기록 복구를 건너뛴다", async () => {
    // 헬스체크 대상이 없게 해 외부 요청 없이 작업 기록 복구 단계만 확인한다(24시간 안에 검사한 lease는 건너뜀).
    await env.DB.leases.updateMany({}, { $set: { last_health_check_at: Date.now() } });
    await handleScheduled("health", env);
    const blocked = await recover();
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { message: string } }).error.message).toContain("정기 복구");

    await env.DB.jobLocks.deleteMany({});
    expect((await recover()).status).toBe(200);
    const leaseId = await missingRecordLease();
    await env.DB.dnsOps.insertOne({ id: uid(), lease_id: leaseId, kind: "repair", cf_ids: [], started_at: 0, attempts: 0, last_error: null });
    await handleScheduled("health", env);
    expect(await ops(leaseId)).toHaveLength(1);
  });

  it("관리자만 실행할 수 있다", async () => {
    const user = await login(`ru-${uid()}@ajou.ac.kr`);
    expect((await call("/api/admin/dns-ops/recover", { method: "POST", session: user })).status).toBe(403);
  });
});

describe("회원 정보 삭제 (live 모드)", () => {
  it("Cloudflare 레코드 삭제가 실패하면 회원 정보를 지우지 않고, 다시 하면 이어서 처리한다", async () => {
    const cf = fakeCloudflare(vi.spyOn(globalThis, "fetch"));
    const email = `wd-${uid()}@ajou.ac.kr`;
    const session = await login(email);
    const name = nm();
    const created = await call("/api/leases", { method: "POST", session, via, body: { name, targetKind: "ip", records: [{ type: "A", host: fq(name), content: "5.5.5.5" }] } });
    const lease = (await created.json()) as LeaseItem;
    const [cfId] = await cfIds(lease.id);

    cf.failWhen = (method) => method === "DELETE";
    const failed = await call("/api/me", { method: "DELETE", session, via, body: { confirmEmail: email } });
    expect(failed.status).toBe(502);
    expect(await env.DB.users.findOne({ email })).not.toBeNull();
    expect((await env.DB.leases.findOne({ id: lease.id }))?.owner_email).toBe(email);

    cf.failWhen = null;
    const ok = await call("/api/me", { method: "DELETE", session, via, body: { confirmEmail: email } });
    expect(ok.status).toBe(200);
    expect(cf.records.has(cfId!)).toBe(false);
    expect(await env.DB.users.findOne({ email })).toBeNull();
  });
});
