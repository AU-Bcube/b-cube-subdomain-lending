import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseDetail, LeaseItem } from "../shared/schemas";
import { parseConfig } from "../worker/env";
import { createDnsClient, type DnsClient } from "../worker/services/cloudflare-dns";
import { OP_MAX_ATTEMPTS, OP_STALE_MS } from "../worker/services/dns-ops";
import { recoverPendingOps, repairLease } from "../worker/services/repair";
import { call, createLease, fakeCloudflare, LIVE_DNS, login, uid, workerWith, type FakeCloudflare, type Session } from "./helpers";

const ZONE = "b-cube.kr";
const fq = (name: string) => `${name}.${ZONE}`;
const nm = () => `rp-${uid()}`;
const via = workerWith(LIVE_DNS);
/** 작업 기록이 cron 복구 대상이 되는 시각 */
const later = () => Date.now() + OP_STALE_MS + 1000;

async function ops(leaseId: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM dns_ops WHERE lease_id = ?`).bind(leaseId).all<{
    kind: string;
    cf_ids: string;
    attempts: number;
    last_error: string | null;
  }>();
  return results;
}

async function cfIds(leaseId: string) {
  const { results } = await env.DB.prepare(`SELECT cf_record_id FROM records WHERE lease_id = ? ORDER BY created_at, id`)
    .bind(leaseId)
    .all<{ cf_record_id: string | null }>();
  return results.map((r) => r.cf_record_id);
}

afterEach(() => vi.restoreAllMocks());

describe("DNS 작업 기록과 복구 (live 모드)", () => {
  let cf: FakeCloudflare;
  let dns: DnsClient;
  let s: Session;

  beforeEach(async () => {
    cf = fakeCloudflare(vi.spyOn(globalThis, "fetch"));
    dns = createDnsClient(parseConfig({ ...env, ...LIVE_DNS } as unknown as Env));
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
    expect((await ops(lease.id)).map((o) => [o.kind, JSON.parse(o.cf_ids)])).toEqual([["replace", [oldId]]]);

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
    expect(await env.DB.prepare(`SELECT 1 FROM leases WHERE id = ?`).bind(leaseId).first()).toBeNull();
    expect((await ops(leaseId)).map((o) => JSON.parse(o.cf_ids))).toEqual([[leftover[0]!.id]]);

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
    await env.DB.prepare(`INSERT INTO dns_ops (id, lease_id, kind, started_at) VALUES (?, ?, 'repair', 0)`).bind(uid(), leaseId).run();
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
    await env.DB.prepare(`UPDATE leases SET status = 'revoked' WHERE id = ?`).bind(lease.id).run();
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
