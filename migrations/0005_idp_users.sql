-- B-CUBE IdP 전환: IdP sub는 Google sub와 같은 값이므로 열 이름만 바꾼다.
ALTER TABLE users RENAME COLUMN google_sub TO idp_sub;
-- 로그인할 때 id_token 클레임으로 덮어쓴다.
ALTER TABLE users ADD COLUMN student_id TEXT;
ALTER TABLE users ADD COLUMN sohakoe_memberships TEXT;  -- JSON 배열
