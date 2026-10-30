/**
 * 로컬 D1 시드 (SPEC §4.3). UI 확인 전용이며 테스트는 이 데이터에 의존하지 않는다.
 *
 * - 멱등: 시드가 소유한 행(페르소나 사용자와 그 소유 데이터, 시드 lease, 시드 reconcile 결과)을 지우고 다시 넣는다.
 * - 시간 값은 실행 시각 기준 상대값이다.
 * - `--local`에만 적용한다. remote 시드는 지원하지 않는다.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_PERSONAS } from "../worker/data/dev-personas";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "bcube-domain";
const ZONE = "b-cube.kr";

if (process.argv.includes("--remote")) {
  console.error("seed는 로컬 D1 전용입니다. --remote는 지원하지 않습니다.");
  process.exit(1);
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days: number, hours = 0) => NOW - days * DAY - hours * HOUR;
const later = (days: number) => NOW + days * DAY;

const SEED_ID_PREFIX = "00000000-5eed-4000-8000-";
const seedId = (n: number) => `${SEED_ID_PREFIX}${n.toString().padStart(12, "0")}`;
const SEED_RECONCILE_ID = 900001;

let dryCounter = 0;
const dryId = () => `dry_seed${(++dryCounter).toString(16).padStart(4, "0")}${"0".repeat(24)}`;

function q(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(Math.trunc(value));
  return `'${value.replace(/'/g, "''")}'`;
}

const persona = (as: string) => {
  const p = DEV_PERSONAS.find((x) => x.as === as);
  if (!p) throw new Error(`persona ${as} 없음`);
  return p;
};
const member1 = persona("user").email;
const member2 = persona("full").email;
const admin = persona("admin").email;
const banned = persona("banned").email;
const newbie = persona("new").email;

// ---------------------------------------------------------------------------
// 사용자
// ---------------------------------------------------------------------------
const firstLogin: Record<string, number> = {
  [member1]: ago(175),
  [member2]: ago(120),
  [newbie]: ago(1),
  [admin]: ago(200),
  [banned]: ago(45),
};
const users = DEV_PERSONAS.map((p) => ({
  email: p.email,
  idp_sub: p.sub,
  name: p.name,
  first_login_at: firstLogin[p.email] ?? ago(30),
  last_login_at: p.as === "banned" ? ago(21) : ago(0, 3),
  banned_at: p.as === "banned" ? ago(20) : null,
  ban_reason: p.as === "banned" ? "피싱 사이트 운영 신고 확인" : null,
}));

// ---------------------------------------------------------------------------
// lease + records
// ---------------------------------------------------------------------------
interface SeedRecord {
  type: "A" | "AAAA" | "CNAME" | "TXT";
  host: string;
  content: string;
  /** 생략하면 서비스 규칙과 같게 TXT 외에는 true */
  proxied?: boolean;
  /** false이면 cf_record_id = NULL (Cloudflare에서 제거된 상태) */
  live?: boolean;
}

interface SeedLease {
  id: string;
  name: string;
  owner: string;
  kind: "vercel" | "ip" | "cname";
  status: "active" | "suspended" | "expired" | "revoked" | "released";
  statusReason?: string;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
  suspendedAt?: number;
  failCount?: number;
  lastCheck?: number | null;
  lastOk?: number | null;
  healthDetail?: string | null;
  records: SeedRecord[];
}

const fqdn = (name: string) => `${name}.${ZONE}`;

const leases: SeedLease[] = [
  {
    id: seedId(1),
    name: "alice-blog",
    owner: member1,
    kind: "vercel",
    status: "active",
    createdAt: ago(60),
    expiresAt: later(120),
    lastCheck: ago(0, 5),
    lastOk: ago(0, 5),
    healthDetail: "HTTP 200",
    records: [
      { type: "CNAME", host: fqdn("alice-blog"), content: "cname.vercel-dns.com" },
      { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fqdn("alice-blog")},7f3c9a1e2b4d6f8012ab` },
    ],
  },
  {
    id: seedId(2),
    name: "alice-api",
    owner: member1,
    kind: "ip",
    status: "active",
    createdAt: ago(170),
    expiresAt: later(10),
    lastCheck: ago(0, 9),
    lastOk: ago(0, 9),
    healthDetail: "TCP 443 연결 성공 (3.35.120.14)",
    records: [
      { type: "A", host: fqdn("alice-api"), content: "3.35.120.14", proxied: true },
      { type: "A", host: fqdn("alice-api"), content: "13.125.42.7", proxied: true },
      { type: "AAAA", host: fqdn("alice-api"), content: "2406:da12:b78:d500::1a", proxied: true },
      { type: "TXT", host: `_acme-challenge.${fqdn("alice-api")}`, content: "Xk3vR9wq2LmN8pTzY4bC6dF1gH5jK7sA0eU" },
    ],
  },
  {
    id: seedId(3),
    name: "alice-old",
    owner: member1,
    kind: "cname",
    status: "suspended",
    suspendedAt: ago(2),
    statusReason: "health_check_failed",
    createdAt: ago(100),
    expiresAt: later(80),
    failCount: 7,
    lastCheck: ago(2),
    lastOk: ago(12),
    healthDetail: "DoH: old-app.herokuapp.com NXDOMAIN",
    records: [{ type: "CNAME", host: fqdn("alice-old"), content: "old-app.herokuapp.com", live: false }],
  },
  {
    id: seedId(4),
    name: "alice-legacy",
    owner: member1,
    kind: "vercel",
    status: "expired",
    createdAt: ago(190),
    expiresAt: ago(10),
    endedAt: ago(10),
    lastCheck: ago(11),
    lastOk: ago(11),
    healthDetail: "HTTP 200",
    records: [{ type: "CNAME", host: fqdn("alice-legacy"), content: "cname.vercel-dns.com", live: false }],
  },
  {
    id: seedId(5),
    name: "bob-1",
    owner: member2,
    kind: "vercel",
    status: "active",
    createdAt: ago(110),
    expiresAt: later(70),
    lastCheck: ago(0, 2),
    lastOk: ago(0, 2),
    healthDetail: "HTTP 308",
    records: [{ type: "CNAME", host: fqdn("bob-1"), content: "cname.vercel-dns.com" }],
  },
  {
    id: seedId(6),
    name: "bob-2",
    owner: member2,
    kind: "ip",
    status: "active",
    createdAt: ago(80),
    expiresAt: later(100),
    lastCheck: ago(0, 7),
    lastOk: ago(0, 7),
    healthDetail: "TCP 80 연결 성공 (43.201.17.88)",
    records: [
      { type: "A", host: fqdn("bob-2"), content: "43.201.17.88" },
      { type: "TXT", host: fqdn("bob-2"), content: "google-site-verification=bob2-example-token" },
    ],
  },
  {
    id: seedId(7),
    name: "bob-3",
    owner: member2,
    kind: "cname",
    status: "active",
    createdAt: ago(30),
    expiresAt: later(150),
    lastCheck: ago(0, 1),
    lastOk: ago(0, 1),
    healthDetail: "HTTP 200",
    records: [{ type: "CNAME", host: fqdn("bob-3"), content: "bob-portfolio.netlify.app" }],
  },
  {
    id: seedId(8),
    name: "spam-site",
    owner: banned,
    kind: "ip",
    status: "revoked",
    statusReason: "피싱 신고",
    createdAt: ago(40),
    expiresAt: later(140),
    endedAt: ago(20, 1),
    lastCheck: ago(21),
    lastOk: ago(21),
    healthDetail: "TCP 443 연결 성공 (52.78.9.140)",
    records: [{ type: "A", host: fqdn("spam-site"), content: "52.78.9.140", live: false }],
  },
];

// ---------------------------------------------------------------------------
// 감사 로그 (최근 60일에 분산)
// ---------------------------------------------------------------------------
interface SeedAudit {
  at: number;
  actor: string | null;
  role: "user" | "admin" | "system";
  action: string;
  lease?: string;
  target?: string;
  detail?: unknown;
}

const L = Object.fromEntries(leases.map((l) => [l.name, l]));
const ip = (n: number) => `203.252.33.${n}`;
const UA = "Mozilla/5.0 (seed)";

const audits: SeedAudit[] = [
  // 로그인 / 거부
  { at: ago(59, 2), actor: admin, role: "admin", action: "auth.login", target: admin },
  { at: ago(58, 5), actor: member1, role: "user", action: "auth.login", target: member1 },
  { at: ago(57, 1), actor: "outsider@gmail.com", role: "user", action: "auth.login_denied", target: "outsider@gmail.com", detail: { reason: "domain_not_allowed" } },
  { at: ago(55, 3), actor: member2, role: "user", action: "auth.login", target: member2 },
  { at: ago(50, 4), actor: member1, role: "user", action: "auth.login", target: member1 },
  { at: ago(45, 6), actor: banned, role: "user", action: "auth.login", target: banned },
  { at: ago(44, 2), actor: "student@ajou.ac.kr", role: "user", action: "auth.login_denied", target: "student@ajou.ac.kr", detail: { reason: "email_unverified" } },
  { at: ago(38, 3), actor: member2, role: "user", action: "auth.login", target: member2 },
  { at: ago(30, 1), actor: member2, role: "user", action: "auth.logout", target: member2 },
  { at: ago(25, 2), actor: admin, role: "admin", action: "auth.login", target: admin },
  { at: ago(19, 8), actor: banned, role: "user", action: "auth.login_denied", target: banned, detail: { reason: "banned" } },
  { at: ago(7, 4), actor: member1, role: "user", action: "auth.login", target: member1 },
  { at: ago(1, 2), actor: newbie, role: "user", action: "auth.login", target: newbie },
  { at: ago(0, 6), actor: "hacker@naver.com", role: "user", action: "auth.login_denied", target: "hacker@naver.com", detail: { reason: "domain_not_allowed" } },

  // 생성
  { at: ago(60), actor: member1, role: "user", action: "lease.create", lease: L["alice-blog"]!.id, target: member1, detail: { name: "alice-blog", targetKind: "vercel", after: L["alice-blog"]!.records.slice(0, 1) } },
  { at: ago(53, 2), actor: member1, role: "user", action: "lease.create", target: member1, detail: { name: "alice-tmp", targetKind: "cname", note: "삭제된 lease" } },
  { at: ago(40), actor: banned, role: "user", action: "lease.create", lease: L["spam-site"]!.id, target: banned, detail: { name: "spam-site", targetKind: "ip", after: L["spam-site"]!.records } },
  { at: ago(30), actor: member2, role: "user", action: "lease.create", lease: L["bob-3"]!.id, target: member2, detail: { name: "bob-3", targetKind: "cname", after: L["bob-3"]!.records } },

  // 레코드 교체
  { at: ago(59, 1), actor: member1, role: "user", action: "lease.update_records", lease: L["alice-blog"]!.id, target: member1, detail: { before: L["alice-blog"]!.records.slice(0, 1), after: L["alice-blog"]!.records } },
  { at: ago(48, 3), actor: member1, role: "user", action: "lease.update_records", lease: L["alice-api"]!.id, target: member1, detail: { before: [{ type: "A", host: fqdn("alice-api"), content: "3.35.120.14", proxied: false }], after: L["alice-api"]!.records.slice(0, 3) } },
  { at: ago(35, 5), actor: member2, role: "user", action: "lease.update_records", lease: L["bob-2"]!.id, target: member2, detail: { before: [{ type: "A", host: fqdn("bob-2"), content: "43.201.17.80" }], after: L["bob-2"]!.records } },
  { at: ago(12, 2), actor: member1, role: "user", action: "lease.update_records", lease: L["alice-api"]!.id, target: member1, detail: { before: L["alice-api"]!.records.slice(0, 3), after: L["alice-api"]!.records } },

  // 연장
  { at: ago(52, 4), actor: member2, role: "user", action: "lease.renew", lease: L["bob-1"]!.id, target: member2, detail: { before: { expiresAt: ago(52) + 20 * DAY }, after: { expiresAt: L["bob-1"]!.expiresAt } } },
  { at: ago(28, 3), actor: member2, role: "user", action: "lease.renew", lease: L["bob-2"]!.id, target: member2, detail: { before: { expiresAt: ago(28) + 25 * DAY }, after: { expiresAt: L["bob-2"]!.expiresAt } } },

  // 헬스체크 실패 → suspend
  ...[11, 10, 9, 8, 7, 6, 5].map((d, i) => ({
    at: ago(d - 3, 1),
    actor: null,
    role: "system" as const,
    action: "system.health_fail",
    lease: L["alice-old"]!.id,
    detail: { failCount: i + 1, reason: "DoH: old-app.herokuapp.com NXDOMAIN" },
  })),
  { at: ago(2), actor: null, role: "system", action: "system.suspend", lease: L["alice-old"]!.id, target: member1, detail: { reason: "health_check_failed", failCount: 7, removed: L["alice-old"]!.records } },
  { at: ago(1, 5), actor: member1, role: "user", action: "lease.recheck", lease: L["alice-old"]!.id, target: member1, detail: { ok: false, reason: "DoH: old-app.herokuapp.com NXDOMAIN" } },

  // 만료
  { at: ago(10), actor: null, role: "system", action: "system.expire", lease: L["alice-legacy"]!.id, target: member1, detail: { removed: L["alice-legacy"]!.records } },

  // 반납
  { at: ago(46, 2), actor: member1, role: "user", action: "lease.release", target: member1, detail: { name: "alice-tmp", removed: [{ type: "CNAME", host: fqdn("alice-tmp"), content: "alice-tmp.pages.dev" }] } },

  // 관리자 조치
  { at: ago(20, 1), actor: admin, role: "admin", action: "admin.revoke", lease: L["spam-site"]!.id, target: banned, detail: { reason: "피싱 신고", removed: L["spam-site"]!.records } },
  { at: ago(20), actor: admin, role: "admin", action: "admin.ban", target: banned, detail: { reason: "피싱 사이트 운영 신고 확인", revokedLeases: [], sessionsDeleted: 1 } },
  { at: ago(33, 4), actor: admin, role: "admin", action: "admin.ban", target: "spammer2@ajou.ac.kr", detail: { reason: "스팸 메일 발송", revokedLeases: [] } },
  { at: ago(31, 2), actor: admin, role: "admin", action: "admin.unban", target: "spammer2@ajou.ac.kr", detail: { reason: "소명 확인" } },

  // 드리프트
  { at: ago(1, 13), actor: null, role: "system", action: "system.drift_detected", detail: { runId: SEED_RECONCILE_ID, count: 2, seed: true } },
];

// ---------------------------------------------------------------------------
// 드리프트 (최근 reconcile 결과 1건)
// ---------------------------------------------------------------------------
const bob1Cname = L["bob-1"]!.records[0]!;
const driftItems: Array<Record<string, string | number | boolean | null>> = [
  {
    kind: "cf_only",
    type: "A",
    host: fqdn("ghost"),
    leaseId: seedId(99),
    recordId: null,
    cfRecordId: "dry_seedghost0000000000000000000",
    dbContent: null,
    cfContent: "15.164.88.21",
    dbProxied: null,
    cfProxied: false,
  },
  {
    kind: "mismatch",
    type: "CNAME",
    host: bob1Cname.host,
    leaseId: L["bob-1"]!.id,
    recordId: `${L["bob-1"]!.id}-r1`,
    cfRecordId: null, // 아래에서 채움
    dbContent: bob1Cname.content,
    cfContent: "bob-old-project.vercel-dns.com",
    dbProxied: false,
    cfProxied: false,
  },
];

// ---------------------------------------------------------------------------
// SQL 생성
// ---------------------------------------------------------------------------
const personaEmails = DEV_PERSONAS.map((p) => q(p.email)).join(", ");
const sql: string[] = [];

sql.push(`-- generated by scripts/seed.ts at ${new Date(NOW).toISOString()}`);
sql.push(
  `DELETE FROM records WHERE lease_id IN (SELECT id FROM leases WHERE owner_email IN (${personaEmails}) OR id LIKE '${SEED_ID_PREFIX}%');`,
  `DELETE FROM leases WHERE owner_email IN (${personaEmails}) OR id LIKE '${SEED_ID_PREFIX}%';`,
  `DELETE FROM sessions WHERE email IN (${personaEmails});`,
  `DELETE FROM audit_logs WHERE actor_email IN (${personaEmails}) OR target_email IN (${personaEmails}) OR lease_id LIKE '${SEED_ID_PREFIX}%' OR user_agent = ${q(UA)} OR detail LIKE '%"seed":true%';`,
  `DELETE FROM reconcile_runs WHERE id = ${SEED_RECONCILE_ID};`,
  `DELETE FROM users WHERE email IN (${personaEmails});`,
);

for (const u of users) {
  sql.push(
    `INSERT INTO users (email, idp_sub, name, first_login_at, last_login_at, banned_at, ban_reason) VALUES (${[
      u.email,
      u.idp_sub,
      u.name,
      u.first_login_at,
      u.last_login_at,
      u.banned_at,
      u.ban_reason,
    ]
      .map(q)
      .join(", ")});`,
  );
}

for (const l of leases) {
  sql.push(
    `INSERT INTO leases (id, name, owner_email, target_kind, status, status_reason, created_at, expires_at, ended_at, suspended_at, health_fail_count, last_health_check_at, last_health_ok_at, last_health_detail) VALUES (${[
      l.id,
      l.name,
      l.owner,
      l.kind,
      l.status,
      l.statusReason ?? null,
      l.createdAt,
      l.expiresAt,
      l.endedAt ?? null,
      l.suspendedAt ?? null,
      l.failCount ?? 0,
      l.lastCheck ?? null,
      l.lastOk ?? null,
      l.healthDetail ?? null,
    ]
      .map(q)
      .join(", ")});`,
  );
  l.records.forEach((r, i) => {
    const recordId = `${l.id}-r${i + 1}`;
    const cfId = r.live === false ? null : dryId();
    if (recordId === driftItems[1]!.recordId) driftItems[1]!.cfRecordId = cfId;
    sql.push(
      `INSERT INTO records (id, lease_id, cf_record_id, type, host, content, proxied, created_at, updated_at) VALUES (${[
        recordId,
        l.id,
        cfId,
        r.type,
        r.host,
        r.content,
        (r.proxied ?? r.type !== "TXT") ? 1 : 0,
        l.createdAt,
        l.createdAt,
      ]
        .map(q)
        .join(", ")});`,
    );
  });
}

audits
  .sort((a, b) => a.at - b.at)
  .forEach((a, i) => {
    sql.push(
      `INSERT INTO audit_logs (at, actor_email, actor_role, action, lease_id, target_email, detail, ip, user_agent) VALUES (${[
        a.at,
        a.actor,
        a.role,
        a.action,
        a.lease ?? null,
        a.target ?? null,
        a.detail === undefined ? null : JSON.stringify(a.detail),
        a.role === "system" ? null : ip(10 + (i % 40)),
        a.role === "system" ? null : UA,
      ]
        .map(q)
        .join(", ")});`,
    );
  });

sql.push(
  `INSERT INTO reconcile_runs (id, at, ok, drift_count, items, error) VALUES (${[
    SEED_RECONCILE_ID,
    ago(1, 13),
    1,
    driftItems.length,
    JSON.stringify(driftItems),
    null,
  ]
    .map(q)
    .join(", ")});`,
);

const outFile = join(ROOT, ".wrangler", "tmp", "seed.sql");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, sql.join("\n") + "\n");

const result = spawnSync(
  join(ROOT, "node_modules", ".bin", "wrangler"),
  ["d1", "execute", DB_NAME, "--local", `--file=${outFile}`],
  { cwd: ROOT, stdio: ["inherit", "ignore", "inherit"] },
);
if (result.status !== 0) {
  console.error("시드 적용 실패. 먼저 `npm run db:migrate:local`을 실행했는지 확인하세요.");
  process.exit(result.status ?? 1);
}
console.log(
  `\n✔ 시드 완료: 사용자 ${users.length}명, lease ${leases.length}개, 감사 로그 ${audits.length}건, 드리프트 ${driftItems.length}건`,
);
