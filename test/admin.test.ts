import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AdminLeaseItem, AdminUserItem, AuditLogItem, DriftResponse, Paged } from "../shared/schemas";
import { ADMIN_EMAIL, auditFor, call, createLease, createUser, login, uid } from "./helpers";

const ZONE = "b-cube.kr";

async function leaseRow(id: string) {
  return env.DB.prepare(`SELECT status, status_reason, ended_at FROM leases WHERE id = ?`).bind(id).first<{
    status: string;
    status_reason: string | null;
    ended_at: number | null;
  }>();
}

async function cfIds(leaseId: string) {
  const { results } = await env.DB.prepare(`SELECT cf_record_id FROM records WHERE lease_id = ? ORDER BY id`)
    .bind(leaseId)
    .all<{ cf_record_id: string | null }>();
  return results.map((r) => r.cf_record_id);
}

describe("관리자 권한", () => {
  it("비로그인 401, 일반 사용자 403, 관리자 200", async () => {
    expect((await call("/api/admin/leases")).status).toBe(401);
    const member = await login(`m-${uid()}@ajou.ac.kr`);
    for (const path of ["/api/admin/leases", "/api/admin/users", "/api/admin/audit-logs", "/api/admin/drift"]) {
      expect((await call(path, { session: member })).status).toBe(403);
    }
    const admin = await login(ADMIN_EMAIL);
    expect((await call("/api/admin/leases", { session: admin })).status).toBe(200);
  });

  it("일반 사용자는 회수·차단 API도 403", async () => {
    const member = await login(`m-${uid()}@ajou.ac.kr`);
    const leaseId = await createLease({ name: `x-${uid()}`, owner: member.email });
    const revoke = await call(`/api/admin/leases/${leaseId}/revoke`, { method: "POST", session: member, body: { reason: "x" } });
    expect(revoke.status).toBe(403);
    const ban = await call(`/api/admin/users/${encodeURIComponent(member.email)}/ban`, {
      method: "POST",
      session: member,
      body: { reason: "x" },
    });
    expect(ban.status).toBe(403);
    expect((await leaseRow(leaseId))?.status).toBe("active");
  });

  it("관리자 요청도 CSRF 검사 (Origin 누락, 다른 서브도메인, 토큰 불일치 → 403)", async () => {
    const admin = await login(ADMIN_EMAIL);
    const leaseId = await createLease({ name: `c-${uid()}`, owner: `o-${uid()}@ajou.ac.kr` });
    const path = `/api/admin/leases/${leaseId}/revoke`;
    const body = { reason: "테스트" };
    expect((await call(path, { method: "POST", session: admin, body, origin: null })).status).toBe(403);
    expect((await call(path, { method: "POST", session: admin, body, origin: "https://evil.b-cube.kr" })).status).toBe(403);
    expect((await call(path, { method: "POST", session: admin, body, csrf: "wrong" })).status).toBe(403);
    expect((await leaseRow(leaseId))?.status).toBe("active");
  });
});

describe("POST /api/admin/leases/:id/revoke", () => {
  it("Cloudflare 레코드 삭제 → revoked, 감사 로그에 변경 전 레코드 기록", async () => {
    const admin = await login(ADMIN_EMAIL);
    const owner = `o-${uid()}@ajou.ac.kr`;
    await createUser(owner);
    const name = `r-${uid()}`;
    const leaseId = await createLease({
      name,
      owner,
      records: [
        { type: "A", host: `${name}.${ZONE}`, content: "1.1.1.1", proxied: true },
        { type: "TXT", host: `_acme-challenge.${name}.${ZONE}`, content: "token" },
      ],
    });

    const res = await call(`/api/admin/leases/${leaseId}/revoke`, { method: "POST", session: admin, body: { reason: "피싱 신고" } });
    expect(res.status).toBe(200);

    const row = await leaseRow(leaseId);
    expect(row).toMatchObject({ status: "revoked", status_reason: "피싱 신고" });
    expect(row?.ended_at).toBeTypeOf("number");
    expect(await cfIds(leaseId)).toEqual([null, null]);

    const logs = await auditFor({ action: "admin.revoke", leaseId });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_email: ADMIN_EMAIL, actor_role: "admin" });
    expect(logs[0]?.detail).toMatchObject({
      reason: "피싱 신고",
      statusBefore: "active",
      removed: [
        { type: "A", host: `${name}.${ZONE}`, content: "1.1.1.1", proxied: true },
        { type: "TXT", host: `_acme-challenge.${name}.${ZONE}`, content: "token", proxied: false },
      ],
    });
  });

  it("suspended도 회수 가능 (Cloudflare에 없는 레코드는 건드리지 않음)", async () => {
    const admin = await login(ADMIN_EMAIL);
    const name = `s-${uid()}`;
    const leaseId = await createLease({
      name,
      owner: `o-${uid()}@ajou.ac.kr`,
      status: "suspended",
      kind: "cname",
      records: [{ type: "CNAME", host: `${name}.${ZONE}`, content: "example.com", cfRecordId: null }],
    });
    const res = await call(`/api/admin/leases/${leaseId}/revoke`, { method: "POST", session: admin, body: { reason: "x" } });
    expect(res.status).toBe(200);
    expect((await leaseRow(leaseId))?.status).toBe("revoked");
    expect((await auditFor({ action: "admin.revoke", leaseId }))[0]?.detail).toMatchObject({ removed: [] });
  });

  it("사유 누락·공백 → 400", async () => {
    const admin = await login(ADMIN_EMAIL);
    const owner = `o-${uid()}@ajou.ac.kr`;
    await createUser(owner);
    const leaseId = await createLease({ name: `v-${uid()}`, owner });
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "a".repeat(501) }]) {
      const res = await call(`/api/admin/leases/${leaseId}/revoke`, { method: "POST", session: admin, body });
      expect(res.status).toBe(400);
    }
    expect((await leaseRow(leaseId))?.status).toBe("active");
  });

  it("없는 lease 404, 이미 끝난 lease 409", async () => {
    const admin = await login(ADMIN_EMAIL);
    const missing = await call(`/api/admin/leases/${crypto.randomUUID()}/revoke`, { method: "POST", session: admin, body: { reason: "x" } });
    expect(missing.status).toBe(404);
    const owner = `o-${uid()}@ajou.ac.kr`;
    await createUser(owner);
    for (const status of ["revoked", "expired", "released"] as const) {
      const leaseId = await createLease({ name: `e-${uid()}`, owner, status, endedAt: Date.now() });
      const res = await call(`/api/admin/leases/${leaseId}/revoke`, { method: "POST", session: admin, body: { reason: "x" } });
      expect(res.status).toBe(409);
      expect((await leaseRow(leaseId))?.status).toBe(status);
    }
  });
});

describe("POST /api/admin/users/:email/ban, unban", () => {
  it("차단: 세션 전부 삭제, active/suspended lease 일괄 revoke(user_banned), 나머지는 유지", async () => {
    const admin = await login(ADMIN_EMAIL);
    const target = await login(`b-${uid()}@ajou.ac.kr`);
    await login(target.email); // 세션 2개
    const active = await createLease({
      name: `a-${uid()}`,
      owner: target.email,
      records: [{ type: "A", host: `x.${ZONE}`, content: "1.1.1.1" }],
    });
    const suspended = await createLease({ name: `s-${uid()}`, owner: target.email, status: "suspended" });
    const expired = await createLease({ name: `e-${uid()}`, owner: target.email, status: "expired", endedAt: Date.now() });

    // 차단 전에는 본인 API 접근 가능
    expect((await call("/api/me", { session: target })).status).toBe(200);

    const res = await call(`/api/admin/users/${encodeURIComponent(target.email)}/ban`, {
      method: "POST",
      session: admin,
      body: { reason: "스팸" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ revokedLeases: string[]; failedLeases: string[] }>();
    expect(body.revokedLeases).toHaveLength(2);
    expect(body.failedLeases).toEqual([]);

    const user = await env.DB.prepare(`SELECT banned_at, ban_reason FROM users WHERE email = ?`).bind(target.email).first<{
      banned_at: number | null;
      ban_reason: string | null;
    }>();
    expect(user?.banned_at).toBeTypeOf("number");
    expect(user?.ban_reason).toBe("스팸");
    const sessions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE email = ?`).bind(target.email).first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    expect((await call("/api/me", { session: target })).status).toBe(401);

    expect(await leaseRow(active)).toMatchObject({ status: "revoked", status_reason: "user_banned" });
    expect(await leaseRow(suspended)).toMatchObject({ status: "revoked", status_reason: "user_banned" });
    expect((await leaseRow(expired))?.status).toBe("expired");
    expect(await cfIds(active)).toEqual([null]);

    const banLogs = await auditFor({ action: "admin.ban", targetEmail: target.email });
    expect(banLogs).toHaveLength(1);
    expect(banLogs[0]?.detail).toMatchObject({ reason: "스팸", sessionsDeleted: 2 });
    expect(await auditFor({ action: "admin.revoke", targetEmail: target.email })).toHaveLength(2);
  });

  it("세션이 남아 있어도 차단된 사용자는 즉시 401", async () => {
    const target = await login(`b-${uid()}@ajou.ac.kr`);
    await env.DB.prepare(`UPDATE users SET banned_at = ? WHERE email = ?`).bind(Date.now(), target.email).run();
    expect((await call("/api/me", { session: target })).status).toBe(401);
  });

  it("자기 자신 400, 없는 사용자 404, 이미 차단 409, 사유 없음 400", async () => {
    const admin = await login(ADMIN_EMAIL);
    const ban = (email: string, body: unknown = { reason: "x" }) =>
      call(`/api/admin/users/${encodeURIComponent(email)}/ban`, { method: "POST", session: admin, body });
    expect((await ban(ADMIN_EMAIL)).status).toBe(400);
    expect((await ban(`none-${uid()}@ajou.ac.kr`)).status).toBe(404);
    const banned = `bb-${uid()}@ajou.ac.kr`;
    await createUser(banned, { banned: true });
    expect((await ban(banned)).status).toBe(409);
    const normal = `n-${uid()}@ajou.ac.kr`;
    await createUser(normal);
    expect((await ban(normal, {})).status).toBe(400);
  });

  it("차단 해제: 차단 정보만 지우고 revoke된 lease는 복구하지 않음", async () => {
    const admin = await login(ADMIN_EMAIL);
    const target = `u-${uid()}@ajou.ac.kr`;
    await createUser(target, { banned: true });
    const leaseId = await createLease({ name: `rv-${uid()}`, owner: target, status: "revoked", endedAt: Date.now() });

    const res = await call(`/api/admin/users/${encodeURIComponent(target)}/unban`, { method: "POST", session: admin, body: {} });
    expect(res.status).toBe(200);
    const user = await env.DB.prepare(`SELECT banned_at, ban_reason FROM users WHERE email = ?`).bind(target).first();
    expect(user).toEqual({ banned_at: null, ban_reason: null });
    expect((await leaseRow(leaseId))?.status).toBe("revoked");
    expect(await auditFor({ action: "admin.unban", targetEmail: target })).toHaveLength(1);

    const again = await call(`/api/admin/users/${encodeURIComponent(target)}/unban`, { method: "POST", session: admin, body: {} });
    expect(again.status).toBe(409);
  });
});

describe("조회 API", () => {
  it("GET /api/admin/leases: 상태 필터, 이름·소유자 검색, 레코드 포함", async () => {
    const admin = await login(ADMIN_EMAIL);
    const tag = uid();
    const owner = `own-${tag}@ajou.ac.kr`;
    await createUser(owner);
    await createLease({ name: `q${tag}-one`, owner, records: [{ type: "A", host: `q${tag}-one.${ZONE}`, content: "1.1.1.1" }] });
    await createLease({ name: `q${tag}-two`, owner, status: "revoked", endedAt: Date.now() });

    const all = await (await call(`/api/admin/leases?q=${tag}`, { session: admin })).json<Paged<AdminLeaseItem>>();
    expect(all.total).toBe(2);
    expect(all.items.map((i) => i.name).sort()).toEqual([`q${tag}-one`, `q${tag}-two`]);
    expect(all.items.find((i) => i.name === `q${tag}-one`)?.records).toEqual([
      expect.objectContaining({ type: "A", content: "1.1.1.1", live: true }),
    ]);

    const revoked = await (await call(`/api/admin/leases?q=${tag}&status=revoked`, { session: admin })).json<Paged<AdminLeaseItem>>();
    expect(revoked.items.map((i) => i.name)).toEqual([`q${tag}-two`]);

    const byOwner = await (await call(`/api/admin/leases?q=${encodeURIComponent(owner)}`, { session: admin })).json<Paged<AdminLeaseItem>>();
    expect(byOwner.total).toBe(2);

    // LIKE 와일드카드는 문자 그대로 취급
    const wildcard = await (await call(`/api/admin/leases?q=${encodeURIComponent("%")}`, { session: admin })).json<Paged<AdminLeaseItem>>();
    expect(wildcard.total).toBe(0);
  });

  it("GET /api/admin/users: 보유 수, 차단 필터", async () => {
    const admin = await login(ADMIN_EMAIL);
    const tag = uid();
    const normal = `usr-${tag}-a@ajou.ac.kr`;
    const banned = `usr-${tag}-b@ajou.ac.kr`;
    await createUser(normal);
    await createUser(banned, { banned: true });
    await createLease({ name: `u${tag}-1`, owner: normal });
    await createLease({ name: `u${tag}-2`, owner: normal, status: "suspended" });
    await createLease({ name: `u${tag}-3`, owner: normal, status: "expired", endedAt: Date.now() });

    const list = await (await call(`/api/admin/users?q=usr-${tag}`, { session: admin })).json<Paged<AdminUserItem>>();
    expect(list.total).toBe(2);
    expect(list.items.find((u) => u.email === normal)).toMatchObject({ liveLeaseCount: 2, totalLeaseCount: 3, bannedAt: null });

    const onlyBanned = await (await call(`/api/admin/users?q=usr-${tag}&banned=true`, { session: admin })).json<Paged<AdminUserItem>>();
    expect(onlyBanned.items.map((u) => u.email)).toEqual([banned]);
    const notBanned = await (await call(`/api/admin/users?q=usr-${tag}&banned=false`, { session: admin })).json<Paged<AdminUserItem>>();
    expect(notBanned.items.map((u) => u.email)).toEqual([normal]);
  });

  it("GET /api/admin/audit-logs: 액션·lease 이름·기간 필터, 페이지네이션", async () => {
    const admin = await login(ADMIN_EMAIL);
    const owner = `al-${uid()}@ajou.ac.kr`;
    await createUser(owner);
    const name = `al-${uid()}`;
    const leaseId = await createLease({ name, owner });
    const base = Date.UTC(2020, 0, 1);
    const stmts = Array.from({ length: 30 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO audit_logs (at, actor_email, actor_role, action, lease_id, target_email, detail) VALUES (?, ?, 'user', ?, ?, ?, ?)`,
      ).bind(base + i * 1000, owner, i % 2 ? "lease.renew" : "lease.update_records", leaseId, owner, JSON.stringify({ i })),
    );
    await env.DB.batch(stmts);

    const page1 = await (await call(`/api/admin/audit-logs?lease=${name}`, { session: admin })).json<Paged<AuditLogItem>>();
    expect(page1.total).toBe(30);
    expect(page1.items).toHaveLength(25);
    expect(page1.items[0]).toMatchObject({ leaseName: name, detail: { i: 29 } });
    const page2 = await (await call(`/api/admin/audit-logs?lease=${name}&page=2`, { session: admin })).json<Paged<AuditLogItem>>();
    expect(page2.items).toHaveLength(5);

    const renew = await (await call(`/api/admin/audit-logs?lease=${leaseId}&action=lease.renew`, { session: admin })).json<Paged<AuditLogItem>>();
    expect(renew.total).toBe(15);

    const ranged = await (
      await call(`/api/admin/audit-logs?actor=${encodeURIComponent(owner)}&from=${base + 10_000}&to=${base + 20_000}`, { session: admin })
    ).json<Paged<AuditLogItem>>();
    expect(ranged.total).toBe(10);
  });

  it("GET /api/admin/drift: 결과 없으면 null, 있으면 최근 1건", async () => {
    const admin = await login(ADMIN_EMAIL);
    await env.DB.prepare(`DELETE FROM reconcile_runs`).run();
    const empty = await (await call("/api/admin/drift", { session: admin })).json<DriftResponse>();
    expect(empty.run).toBeNull();

    const items = [{ kind: "cf_only", type: "A", host: `ghost.${ZONE}`, leaseId: null, recordId: null, cfRecordId: "cf1", dbContent: null, cfContent: "1.1.1.1", dbProxied: null, cfProxied: false }];
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO reconcile_runs (at, ok, drift_count, items) VALUES (?, 1, 0, '[]')`).bind(1000),
      env.DB.prepare(`INSERT INTO reconcile_runs (at, ok, drift_count, items) VALUES (?, 1, 1, ?)`).bind(2000, JSON.stringify(items)),
    ]);
    const latest = await (await call("/api/admin/drift", { session: admin })).json<DriftResponse>();
    expect(latest.run).toMatchObject({ at: 2000, ok: true, driftCount: 1, items });
  });
});
