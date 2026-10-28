-- SPEC 추가 (§10.2): 작업 실행 잠금. 같은 작업이 cron과 수동 실행으로 겹치지 않게 한다.
-- started_at으로부터 정해진 시간(작업 기록 복구는 3분) 동안 같은 이름의 다른 실행을 막는다.
CREATE TABLE job_locks (
  name        TEXT PRIMARY KEY,              -- 'dns_ops_recover'
  started_at  INTEGER NOT NULL,
  trigger     TEXT NOT NULL                  -- 'cron' | 'manual'
);
