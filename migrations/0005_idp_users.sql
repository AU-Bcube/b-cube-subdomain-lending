-- B-CUBE IdP 전환: IdP sub는 Google sub와 같은 값이므로 열 이름만 바꾼다.
ALTER TABLE users RENAME COLUMN google_sub TO idp_sub;
