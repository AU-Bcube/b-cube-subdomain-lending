import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseDetail, LeaseItem, LeasesResponse } from "../shared/schemas";
import {
  auditFor,
  call,
  createLease,
  fakeCloudflare,
  LIVE_DNS,
  login,
  uid,
  workerWith,
  type FakeCloudflare,
  type Session,
} from "./helpers";

const ZONE = "b-cube.kr";
const DAY = 24 * 60 * 60 * 1000;
const fq = (name: string) => `${name}.${ZONE}`;
/** 테스트마다 겹치지 않는 이름 (영문 소문자로 시작) */
const nm = (prefix = "t") => `${prefix}-${uid()}`;

const vercelRecords = (name: string) => [{ type: "CNAME", host: fq(name), content: "cname.vercel-dns.com" }];

async function leaseRow(id: string) {
  return env.DB.prepare(`SELECT * FROM leases WHERE id = ?`).bind(id).first<{
    status: string;
    ended_at: number | null;
    expires_at: number;
  }>();
}

async function recordRows(leaseId: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM records WHERE lease_id = ? ORDER BY created_at, id`)
    .bind(leaseId)
    .all<{ id: string; cf_record_id: string | null; type: string; host: string; content: string }>();
  return results;
}

afterEach(() => vi.restoreAllMocks());

describe("인증·권한", () => {
  it("비로그인 401", async () => {
    expect((await call("/api/leases")).status).toBe(401);
    expect((await call(`/api/names/${nm()}/availability`)).status).toBe(401);
  });

  it("남의 lease는 조회·수정·연장·재확인·반납 모두 404", async () => {
    const owner = `o-${uid()}@ajou.ac.kr`;
    const id = await createLease({ name: nm(), owner, kind: "cname", records: [{ type: "CNAME", host: fq("x"), content: "example.com" }] });
    const other = await login(`x-${uid()}@ajou.ac.kr`);
    expect((await call(`/api/leases/${id}`, { session: other })).status).toBe(404);
    expect((await call(`/api/leases/${id}/records`, { method: "PUT", session: other, body: { records: vercelRecords("x") } })).status).toBe(404);
    for (const path of [`/api/leases/${id}/renew`, `/api/leases/${id}/recheck`]) {
      expect((await call(path, { method: "POST", session: other })).status).toBe(404);
    }
    expect((await call(`/api/leases/${id}`, { method: "DELETE", session: other })).status).toBe(404);
    expect((await leaseRow(id))?.status).toBe("active");
  });

  it("CSRF: 다른 서브도메인 Origin, 토큰 없음 → 403", async () => {
    const s = await login(`c-${uid()}@ajou.ac.kr`);
    const name = nm();
    const body = { name, targetKind: "vercel", records: vercelRecords(name) };
    expect((await call("/api/leases", { method: "POST", session: s, body, origin: `https://${fq("evil")}` })).status).toBe(403);
    expect((await call("/api/leases", { method: "POST", session: s, body, csrf: null })).status).toBe(403);
    expect((await call("/api/leases", { session: s })).status).toBe(200);
  });
});

describe("GET /api/names/:name/availability", () => {
  let s: Session;
  beforeEach(async () => {
    s = await login(`n-${uid()}@ajou.ac.kr`);
  });
  const check = async (name: string, session = s) => (await call(`/api/names/${name}/availability`, { session })).json();

  it("정적 규칙: 형식, 예약어, 금칙어", async () => {
    expect(await check("ab")).toEqual({ available: false, reason: "invalid_format" });
    expect(await check("a--b")).toEqual({ available: false, reason: "invalid_format" });
    expect(await check("www")).toEqual({ available: false, reason: "reserved" });
    expect(await check("my-kakao-shop")).toEqual({ available: false, reason: "banned_word" });
    expect(await check(nm("free"))).toEqual({ available: true });
  });

  it("대문자는 소문자로 정규화해 검사한다", async () => {
    expect(await check("WWW")).toEqual({ available: false, reason: "reserved" });
  });

  it("EXTRA_RESERVED_NAMES도 막는다", async () => {
    const via = workerWith({ EXTRA_RESERVED_NAMES: "club-site, Extra-One" });
    const res = await call("/api/names/extra-one/availability", { session: s, via });
    expect(await res.json()).toEqual({ available: false, reason: "reserved" });
  });

  it("taken: active/suspended가 있으면", async () => {
    const name = nm();
    await createLease({ name, owner: `o-${uid()}@ajou.ac.kr`, status: "suspended" });
    expect(await check(name)).toEqual({ available: false, reason: "taken" });
  });

  it("held: revoked는 보류 기간 동안 누구도 신청 불가", async () => {
    const name = nm();
    await createLease({ name, owner: s.email, status: "revoked", endedAt: Date.now() - DAY });
    expect(await check(name)).toEqual({ available: false, reason: "held" });
  });

  it("held: expired/released는 원래 소유자만 신청 가능, 보류 기간이 지나면 누구나", async () => {
    const name = nm();
    const other = await login(`p-${uid()}@ajou.ac.kr`);
    await createLease({ name, owner: s.email, status: "released", endedAt: Date.now() - DAY });
    expect(await check(name)).toEqual({ available: true });
    expect(await check(name, other)).toEqual({ available: false, reason: "held" });

    const old = nm();
    await createLease({ name: old, owner: s.email, status: "expired", endedAt: Date.now() - 31 * DAY });
    expect(await check(old, other)).toEqual({ available: true });
  });

  it("conflict: Cloudflare에 이름이나 와일드카드 레코드가 있으면 (이 앱이 만들지 않은 레코드)", async () => {
    const cf = fakeCloudflare(vi.spyOn(globalThis, "fetch"));
    const via = workerWith(LIVE_DNS);
    const name = nm();
    cf.records.set("ext-1", { id: "ext-1", type: "A", name: `*.${fq(name)}`, content: "1.2.3.4", proxied: false, comment: null });
    const res = await call(`/api/names/${name}/availability`, { session: s, via });
    expect(await res.json()).toEqual({ available: false, reason: "conflict" });
    expect(cf.calls).toEqual([`GET name=${encodeURIComponent(fq(name))}`, `GET name=${encodeURIComponent(`*.${fq(name)}`)}`]);
    // 조회만 하고 기존 레코드는 건드리지 않는다
    expect(cf.records.has("ext-1")).toBe(true);
  });
});

describe("POST /api/leases (dry-run)", () => {
  it("생성: 201, 레코드 정규화, 감사 로그, 사용량 증가", async () => {
    const s = await login(`a-${uid()}@ajou.ac.kr`);
    const name = nm();
    const res = await call("/api/leases", {
      method: "POST",
      session: s,
      body: {
        name: name.toUpperCase(),
        targetKind: "ip",
        records: [
          { type: "A", host: fq(name).toUpperCase(), content: "3.35.120.14", proxied: true },
          { type: "TXT", host: `_acme-challenge.${fq(name)}.`, content: "token-value" },
        ],
      },
    });
    expect(res.status).toBe(201);
    const lease = (await res.json()) as LeaseItem;
    expect(lease).toMatchObject({ name, fqdn: fq(name), targetKind: "ip", status: "active", renewable: false });
    expect(lease.expiresAt - lease.createdAt).toBe(180 * DAY);
    expect(lease.records).toEqual([
      expect.objectContaining({ type: "A", host: fq(name), content: "3.35.120.14", proxied: true, live: true }),
      expect.objectContaining({ type: "TXT", host: `_acme-challenge.${fq(name)}`, proxied: false, live: true }),
    ]);
    const rows = await recordRows(lease.id);
    expect(rows.every((r) => r.cf_record_id?.startsWith("dry_"))).toBe(true);

    const logs = await auditFor({ action: "lease.create", leaseId: lease.id });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_email: s.email, actor_role: "user" });
    expect(logs[0]?.detail).toMatchObject({ name, targetKind: "ip", after: expect.any(Array) });

    const me = (await (await call("/api/me", { session: s })).json()) as { limits: { used: number } };
    expect(me.limits.used).toBe(1);
  });

  it("레코드 규칙 위반 → 400 invalid_records + 항목별 errors", async () => {
    const s = await login(`b-${uid()}@ajou.ac.kr`);
    const name = nm();
    const res = await call("/api/leases", {
      method: "POST",
      session: s,
      body: { name, targetKind: "ip", records: [{ type: "A", host: fq(name), content: "192.168.0.1" }] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; errors: Array<{ index: number; code: string }> } };
    expect(body.error.code).toBe("invalid_records");
    expect(body.error.errors).toEqual([expect.objectContaining({ index: 0, code: "ip_not_public" })]);
  });

  it("이름 규칙 위반 → 400(예약어) / 409(taken)", async () => {
    const s = await login(`c-${uid()}@ajou.ac.kr`);
    const reserved = await call("/api/leases", { method: "POST", session: s, body: { name: "admin", targetKind: "vercel", records: vercelRecords("admin") } });
    expect(reserved.status).toBe(400);
    expect(((await reserved.json()) as { error: { code: string } }).error.code).toBe("reserved");

    const name = nm();
    await createLease({ name, owner: `z-${uid()}@ajou.ac.kr` });
    const taken = await call("/api/leases", { method: "POST", session: s, body: { name, targetKind: "vercel", records: vercelRecords(name) } });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: { code: string } }).error.code).toBe("taken");
  });

  it("1인당 한도: active+suspended가 3개면 409 limit_reached (expired는 세지 않음)", async () => {
    const s = await login(`l-${uid()}@ajou.ac.kr`);
    await createLease({ name: nm(), owner: s.email });
    await createLease({ name: nm(), owner: s.email, status: "suspended" });
    await createLease({ name: nm(), owner: s.email, status: "expired", endedAt: Date.now() - 40 * DAY });
    const name3 = nm();
    expect((await call("/api/leases", { method: "POST", session: s, body: { name: name3, targetKind: "vercel", records: vercelRecords(name3) } })).status).toBe(201);
    const name4 = nm();
    const res = await call("/api/leases", { method: "POST", session: s, body: { name: name4, targetKind: "vercel", records: vercelRecords(name4) } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("limit_reached");
  });
});

describe("Cloudflare 호출 순서와 롤백 (live 모드)", () => {
  let cf: FakeCloudflare;
  let s: Session;
  const via = workerWith(LIVE_DNS);
  beforeEach(async () => {
    cf = fakeCloudflare(vi.spyOn(globalThis, "fetch"));
    s = await login(`live-${uid()}@ajou.ac.kr`);
  });

  async function create(name: string, records: unknown[], targetKind = "vercel") {
    return call("/api/leases", { method: "POST", session: s, via, body: { name, targetKind, records } });
  }

  it("생성: 충돌 조회 → 레코드 생성, comment에 lease id만 기록", async () => {
    const name = nm();
    const res = await create(name, [
      ...vercelRecords(name),
      { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fq(name)},abc123` },
    ]);
    expect(res.status).toBe(201);
    const lease = (await res.json()) as LeaseItem;
    expect(cf.calls).toEqual([
      `GET name=${encodeURIComponent(fq(name))}`,
      `GET name=${encodeURIComponent(`*.${fq(name)}`)}`,
      `POST CNAME ${fq(name)} cname.vercel-dns.com`,
      `POST TXT _vercel.${ZONE} vc-domain-verify=${fq(name)},abc123`,
    ]);
    const remote = [...cf.records.values()];
    expect(remote.every((r) => r.comment === `bcd:lease=${lease.id}` && r.proxied === false)).toBe(true);
    expect((await recordRows(lease.id)).map((r) => r.cf_record_id)).toEqual(remote.map((r) => r.id));
  });

  it("생성 중 실패 → 이미 만든 레코드 삭제, DB에 lease 없음, 502", async () => {
    const name = nm();
    cf.failWhen = (method, rec) => method === "POST" && rec.type === "TXT";
    const res = await create(name, [
      ...vercelRecords(name),
      { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fq(name)},x` },
    ]);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "dns_error",
      message: expect.not.stringContaining("boom"), // Cloudflare 원문 메시지를 노출하지 않음
    });
    expect(cf.calls.slice(2)).toEqual([
      `POST CNAME ${fq(name)} cname.vercel-dns.com`,
      `POST TXT _vercel.${ZONE} vc-domain-verify=${fq(name)},x`,
      "DELETE cf-1",
    ]);
    expect(cf.records.size).toBe(0);
    expect(await env.DB.prepare(`SELECT 1 FROM leases WHERE name = ?`).bind(name).first()).toBeNull();
  });

  it("교체: 같은 레코드 유지, CNAME은 PATCH, 새 레코드 생성 → DB 갱신 → 기존 레코드 삭제", async () => {
    const name = nm();
    const txt1 = { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fq(name)},one` };
    const txt2 = { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fq(name)},two` };
    const lease = (await (await create(name, [...vercelRecords(name), txt1])).json()) as LeaseItem;
    const before = await recordRows(lease.id);
    cf.calls.length = 0;

    const res = await call(`/api/leases/${lease.id}/records`, {
      method: "PUT",
      session: s,
      via,
      body: { records: [{ type: "CNAME", host: fq(name), content: "abc123.vercel-dns-017.com" }, txt2] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: true });
    const cnameId = before.find((r) => r.type === "CNAME")!.cf_record_id;
    const oldTxtId = before.find((r) => r.type === "TXT")!.cf_record_id;
    expect(cf.calls).toEqual([`PATCH ${cnameId} abc123.vercel-dns-017.com`, `POST TXT _vercel.${ZONE} ${txt2.content}`, `DELETE ${oldTxtId}`]);

    const after = await recordRows(lease.id);
    expect(after.map((r) => [r.type, r.content])).toEqual([
      ["CNAME", "abc123.vercel-dns-017.com"],
      ["TXT", txt2.content],
    ]);
    expect(new Set([...cf.records.values()].map((r) => r.content))).toEqual(new Set(["abc123.vercel-dns-017.com", txt2.content]));
    const logs = await auditFor({ action: "lease.update_records", leaseId: lease.id });
    expect(logs[0]?.detail).toMatchObject({ before: [expect.objectContaining({ content: "cname.vercel-dns.com" }), expect.anything()] });
  });

  it("교체 중 실패 → PATCH 되돌림, DB 변경 없음", async () => {
    const name = nm();
    const lease = (await (await create(name, vercelRecords(name))).json()) as LeaseItem;
    const before = await recordRows(lease.id);
    cf.calls.length = 0;
    cf.failWhen = (method) => method === "POST";
    const res = await call(`/api/leases/${lease.id}/records`, {
      method: "PUT",
      session: s,
      via,
      body: {
        records: [
          { type: "CNAME", host: fq(name), content: "zz.vercel-dns.com" },
          { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fq(name)},x` },
        ],
      },
    });
    expect(res.status).toBe(502);
    const cnameId = before[0]!.cf_record_id;
    expect(cf.calls).toEqual([`PATCH ${cnameId} zz.vercel-dns.com`, expect.stringMatching(/^POST TXT/), `PATCH ${cnameId} cname.vercel-dns.com`]);
    expect(cf.records.get(cnameId!)?.content).toBe("cname.vercel-dns.com");
    expect(await recordRows(lease.id)).toEqual(before);
    expect(await auditFor({ action: "lease.update_records", leaseId: lease.id })).toHaveLength(0);
  });

  it("변경 없는 교체는 Cloudflare를 호출하지 않고 감사 로그도 남기지 않는다", async () => {
    const name = nm();
    const lease = (await (await create(name, vercelRecords(name))).json()) as LeaseItem;
    cf.calls.length = 0;
    const res = await call(`/api/leases/${lease.id}/records`, { method: "PUT", session: s, via, body: { records: vercelRecords(name) } });
    expect(await res.json()).toEqual({ ok: true, changed: false });
    expect(cf.calls).toEqual([]);
  });

  it("반납: Cloudflare 삭제 → released, DB records는 이력으로 유지", async () => {
    const name = nm();
    const lease = (await (await create(name, vercelRecords(name))).json()) as LeaseItem;
    cf.calls.length = 0;
    const res = await call(`/api/leases/${lease.id}`, { method: "DELETE", session: s, via });
    expect(res.status).toBe(200);
    expect(cf.calls).toEqual([expect.stringMatching(/^DELETE cf-/)]);
    expect(cf.records.size).toBe(0);
    const row = await leaseRow(lease.id);
    expect(row?.status).toBe("released");
    expect(row?.ended_at).toEqual(expect.any(Number));
    expect((await recordRows(lease.id)).map((r) => r.cf_record_id)).toEqual([null]);
    const logs = await auditFor({ action: "lease.release", leaseId: lease.id });
    expect(logs[0]?.detail).toMatchObject({ name, removed: [expect.objectContaining({ type: "CNAME" })] });

    // 원래 소유자는 보류 기간 안에도 다시 신청할 수 있다
    expect((await create(name, vercelRecords(name))).status).toBe(201);
  });

  it("이 앱이 만들지 않은 레코드는 건드리지 않는다", async () => {
    cf.records.set("foreign", { id: "foreign", type: "A", name: `www.${ZONE}`, content: "1.1.1.1", proxied: true, comment: null });
    const name = nm();
    const lease = (await (await create(name, vercelRecords(name))).json()) as LeaseItem;
    await call(`/api/leases/${lease.id}/records`, {
      method: "PUT",
      session: s,
      via,
      body: { records: [{ type: "CNAME", host: fq(name), content: "q.vercel-dns.com" }] },
    });
    await call(`/api/leases/${lease.id}`, { method: "DELETE", session: s, via });
    expect(cf.records.get("foreign")).toBeTruthy();
    expect(cf.calls.some((c) => c.includes("foreign"))).toBe(false);
  });
});

describe("상태 규칙", () => {
  it("레코드 교체는 active에서만 (suspended → 409)", async () => {
    const s = await login(`st-${uid()}@ajou.ac.kr`);
    const name = nm();
    const id = await createLease({ name, owner: s.email, kind: "vercel", status: "suspended", records: [{ type: "CNAME", host: fq(name), content: "cname.vercel-dns.com", cfRecordId: null }] });
    const res = await call(`/api/leases/${id}/records`, { method: "PUT", session: s, body: { records: vercelRecords(name) } });
    expect(res.status).toBe(409);
  });

  it("연장: 만료 30일 이내만 가능, expires_at = now + 180일", async () => {
    const s = await login(`rn-${uid()}@ajou.ac.kr`);
    const far = await createLease({ name: nm(), owner: s.email, expiresAt: Date.now() + 60 * DAY });
    const far1 = await call(`/api/leases/${far}/renew`, { method: "POST", session: s });
    expect(far1.status).toBe(409);
    expect(((await far1.json()) as { error: { code: string } }).error.code).toBe("renew_not_allowed");

    const near = await createLease({ name: nm(), owner: s.email, expiresAt: Date.now() + 10 * DAY });
    const before = Date.now();
    const res = await call(`/api/leases/${near}/renew`, { method: "POST", session: s });
    expect(res.status).toBe(200);
    const row = await leaseRow(near);
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + 180 * DAY);
    expect(await auditFor({ action: "lease.renew", leaseId: near })).toHaveLength(1);
  });

  it("종료된 lease는 반납·재확인 불가 (409)", async () => {
    const s = await login(`end-${uid()}@ajou.ac.kr`);
    const id = await createLease({ name: nm(), owner: s.email, status: "expired", endedAt: Date.now() });
    expect((await call(`/api/leases/${id}`, { method: "DELETE", session: s })).status).toBe(409);
    expect((await call(`/api/leases/${id}/recheck`, { method: "POST", session: s })).status).toBe(409);
  });
});

describe("GET /api/leases, /api/leases/:id", () => {
  it("내 lease만, 레코드와 연장 가능 여부 포함", async () => {
    const s = await login(`ls-${uid()}@ajou.ac.kr`);
    const mine = await createLease({ name: nm(), owner: s.email, expiresAt: Date.now() + 5 * DAY });
    await createLease({ name: nm(), owner: `else-${uid()}@ajou.ac.kr` });
    const body = (await (await call("/api/leases", { session: s })).json()) as LeasesResponse;
    expect(body.items.map((l) => l.id)).toEqual([mine]);
    expect(body.items[0]?.renewable).toBe(true);
    expect(body.renewWindowDays).toBe(30);
  });

  it("상세는 이 lease의 감사 로그를 포함하되 작업자 이메일·IP는 숨긴다", async () => {
    const s = await login(`dt-${uid()}@ajou.ac.kr`);
    const id = await createLease({ name: nm(), owner: s.email, expiresAt: Date.now() + 5 * DAY });
    await call(`/api/leases/${id}/renew`, { method: "POST", session: s });
    const detail = (await (await call(`/api/leases/${id}`, { session: s })).json()) as LeaseDetail;
    expect(detail.auditLogs).toEqual([expect.objectContaining({ action: "lease.renew", actorRole: "user" })]);
    expect(detail.auditLogs[0]).not.toHaveProperty("actorEmail");
    expect(detail.auditLogs[0]).not.toHaveProperty("ip");
  });
});
