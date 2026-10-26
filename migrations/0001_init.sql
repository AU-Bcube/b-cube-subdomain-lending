-- B-CUBE Domain Console 초기 스키마 (SPEC §5)
-- 시각 값은 모두 unix ms.

CREATE TABLE users (
  email          TEXT PRIMARY KEY,          -- 소문자 정규화
  google_sub     TEXT NOT NULL UNIQUE,
  name           TEXT,
  first_login_at INTEGER NOT NULL,
  last_login_at  INTEGER NOT NULL,
  banned_at      INTEGER,
  ban_reason     TEXT
);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,             -- SHA-256(세션 토큰), 원문 저장 금지
  email       TEXT NOT NULL REFERENCES users(email),
  csrf_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_email ON sessions(email);

CREATE TABLE leases (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,       -- 'alice' (존 이름 제외)
  owner_email          TEXT NOT NULL REFERENCES users(email),
  target_kind          TEXT NOT NULL,       -- 'vercel' | 'ip' | 'cname'
  status               TEXT NOT NULL,       -- 'active' | 'suspended' | 'expired' | 'revoked' | 'released'
  status_reason        TEXT,
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  ended_at             INTEGER,             -- expired/revoked/released 시각
  health_fail_count    INTEGER NOT NULL DEFAULT 0,
  last_health_check_at INTEGER,
  last_health_ok_at    INTEGER,
  last_health_detail   TEXT
);
-- 같은 이름은 active/suspended 상태로 하나만 존재
CREATE UNIQUE INDEX uq_leases_name_live ON leases(name) WHERE status IN ('active','suspended');
CREATE INDEX idx_leases_owner ON leases(owner_email);
CREATE INDEX idx_leases_health ON leases(status, last_health_check_at);

CREATE TABLE records (
  id            TEXT PRIMARY KEY,
  lease_id      TEXT NOT NULL REFERENCES leases(id),
  cf_record_id  TEXT,                       -- suspended 상태에서는 NULL(Cloudflare에서 제거됨)
  type          TEXT NOT NULL,              -- 'A' | 'AAAA' | 'CNAME' | 'TXT'
  host          TEXT NOT NULL,              -- FQDN
  content       TEXT NOT NULL,
  proxied       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_records_lease ON records(lease_id);

CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  actor_email  TEXT,                        -- 시스템(cron)이면 NULL
  actor_role   TEXT NOT NULL,               -- 'user' | 'admin' | 'system'
  action       TEXT NOT NULL,
  lease_id     TEXT,
  target_email TEXT,
  detail       TEXT,                        -- JSON
  ip           TEXT,                        -- CF-Connecting-IP
  user_agent   TEXT
);
CREATE INDEX idx_audit_at ON audit_logs(at);
CREATE INDEX idx_audit_lease ON audit_logs(lease_id);
CREATE INDEX idx_audit_actor ON audit_logs(actor_email);

-- SPEC 추가: 드리프트 점검(reconcile) 실행 결과. 관리자 드리프트 탭이 최근 1건을 보여준다.
CREATE TABLE reconcile_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  ok           INTEGER NOT NULL,            -- 1이면 Cloudflare 조회 성공
  drift_count  INTEGER NOT NULL,
  items        TEXT NOT NULL,               -- JSON 배열 (cf_only / db_only / mismatch)
  error        TEXT
);
CREATE INDEX idx_reconcile_at ON reconcile_runs(at);
