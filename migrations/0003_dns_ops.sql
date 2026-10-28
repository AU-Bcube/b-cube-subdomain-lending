-- SPEC 추가 (§5, §8): DNS 작업 기록(intent log)과 드리프트 자동 복구 결과.

-- Cloudflare 호출 전에 쓰고, DB 반영과 같은 batch에서 지운다.
-- 남아 있는 행은 중간에 실패했거나 Worker가 끊긴 작업이다. 매시 cron이 lease를 DB 기준 상태로 맞춘다.
CREATE TABLE dns_ops (
  id          TEXT PRIMARY KEY,
  lease_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- 'create' | 'replace' | 'reactivate' | 'release' | 'revoke' | 'expire' | 'suspend' | 'repair'
  cf_ids      TEXT NOT NULL DEFAULT '[]',    -- 이 작업이 만들었거나 지워야 할 Cloudflare 레코드 id (JSON 배열)
  started_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,    -- cron 복구 시도 횟수
  last_error  TEXT
);
CREATE INDEX idx_dns_ops_started ON dns_ops(started_at);
CREATE INDEX idx_dns_ops_lease ON dns_ops(lease_id);

-- 드리프트 점검이 자동 복구한 내용 (JSON). 복구가 없으면 NULL.
ALTER TABLE reconcile_runs ADD COLUMN repaired TEXT;
