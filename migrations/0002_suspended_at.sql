-- suspended로 바뀐 시각 (SPEC §10.2: suspended 상태로 NAME_HOLD_DAYS가 지나면 expired로 전환)
ALTER TABLE leases ADD COLUMN suspended_at INTEGER;
