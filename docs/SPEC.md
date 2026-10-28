# SPEC — B-CUBE Domain Console (`domain.b-cube.kr`)

> 이 문서는 Claude Code에 전달하는 구현 명세다. 프로젝트 루트에 `SPEC.md`로 두고 다음과 같이 지시한다.
> "SPEC.md를 읽고 마일스톤 M1부터 순서대로 구현해. 각 마일스톤이 끝나면 멈추고 결과를 보고해."

---

## 0. 작업 규칙 (Claude Code 필독)

1. **마일스톤 단위로 진행**하고, 각 마일스톤이 끝날 때마다 변경 요약과 다음 단계를 보고한 뒤 멈춘다.
2. **운영 환경에 영향을 주는 명령은 실행 전에 반드시 사용자 확인을 받는다.**
   - 대상: `wrangler deploy`, `wrangler d1 migrations apply --remote`, `wrangler secret put`, 실제 Cloudflare DNS API 호출
3. **시크릿을 코드, 커밋, 로그에 절대 남기지 않는다.** `.dev.vars`는 `.gitignore`에 넣고, `.dev.vars.example`만 커밋한다.
4. **이 앱이 생성하지 않은 DNS 레코드는 절대 수정하거나 삭제하지 않는다.** DB에 `cf_record_id`가 있는 레코드만 조작한다.
5. 로컬 개발에서는 `DNS_DRY_RUN=true`가 기본값이다. 이 값이 true이면 Cloudflare API를 호출하지 않고 가짜 record id를 반환하며 로그만 남긴다.
6. 언어는 **TypeScript (strict)** 를 쓴다. 런타임은 Cloudflare Workers이고, Node 전용 API는 `nodejs_compat` 범위 안에서만 쓴다.
7. 외부 서비스 형식(Vercel 검증 TXT 형식, Cloudflare API 필드 제한 등)은 **구현 시점에 공식 문서로 확인**하고, 이 문서와 다르면 보고한다.
8. UI 문구는 **한국어**로 작성한다.

## 1. 개요

아주대 동아리 B-CUBE 회원(@ajou.ac.kr Google 계정)이 웹 콘솔에서 `<name>.b-cube.kr` 서브도메인을 대여한다. 대여한 서브도메인은 Vercel, AWS(IP) 등에 연결한다.

- DNS: Cloudflare (b-cube.kr 존, 네임서버가 Cloudflare)
- 전체 앱: Cloudflare Workers 하나 (API + 정적 프론트 + Cron)
- 콘솔 주소: `https://domain.b-cube.kr` (Worker 커스텀 도메인)

## 2. 기술 스택

| 영역 | 선택 |
|---|---|
| 백엔드 | Cloudflare Workers + **Hono** |
| DB | **Cloudflare D1** (SQLite), 마이그레이션은 `migrations/*.sql` |
| 프론트 | **React + Vite + `@carbon/react`** (IBM Carbon Design System v11), Sass(`@carbon/styles`) |
| 번들/개발 | **`@cloudflare/vite-plugin`**: Worker와 SPA를 하나의 Vite 개발 서버(5173)로 실행 |
| 정적 서빙 | Workers Static Assets (`not_found_handling: "single-page-application"`) |
| JWT 검증 | **`jose`** (`createRemoteJWKSet`) |
| 입력 검증 | **`zod`** (서버/클라이언트 스키마 공유) |
| 테스트 | **Vitest + `@cloudflare/vitest-pool-workers`** |
| 폰트 | IBM Plex Sans KR |

## 3. 디렉터리 구조 (권장)

```
/
├─ SPEC.md
├─ wrangler.jsonc
├─ vite.config.ts
├─ .dev.vars.example
├─ migrations/0001_init.sql
├─ scripts/
│  ├─ seed.ts               # 시드 SQL 생성 + 로컬 D1 적용 (§4.3)
│  └─ reset-local-db.ts     # 로컬 D1 초기화
├─ shared/                  # 서버·클라이언트 공용
│  ├─ schemas.ts            # zod 스키마, 타입
│  └─ rules.ts              # 이름/레코드 검증 규칙(순수 함수)
├─ worker/
│  ├─ index.ts              # Hono 앱 + scheduled 핸들러
│  ├─ env.ts                # Env 타입, 설정 파싱
│  ├─ auth/                 # google oauth, session, csrf
│  ├─ middleware/           # requireUser, requireAdmin, csrf, securityHeaders
│  ├─ routes/               # auth, me, leases, admin, dev(개발 모드에서만 등록)
│  ├─ services/
│  │  ├─ cloudflare-dns.ts  # CF API 래퍼(dry-run 지원)
│  │  ├─ leases.ts          # 비즈니스 로직
│  │  ├─ audit.ts
│  │  └─ health.ts          # 헬스체크(탈취 방지)
│  ├─ cron/                 # expiry, health, reconcile
│  └─ data/
│     ├─ reserved-names.ts
│     └─ banned-words.ts
├─ src/                     # React SPA
│  ├─ main.tsx, App.tsx, styles.scss
│  ├─ api/client.ts         # fetch 래퍼(CSRF 헤더 자동 첨부)
│  ├─ pages/                # Login, MyLeases, NewLease, LeaseDetail, Admin/*
│  └─ components/
└─ test/
```

## 4. 설정 (wrangler.jsonc / 환경변수)

```jsonc
{
  "name": "bcube-domain-console",
  "main": "worker/index.ts",
  "compatibility_date": "<구현 시점 날짜>",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "not_found_handling": "single-page-application", "run_worker_first": ["/api/*", "/auth/*"] },
  "routes": [{ "pattern": "domain.b-cube.kr", "custom_domain": true }],
  "d1_databases": [{ "binding": "DB", "database_name": "bcube-domain", "database_id": "<생성 후 기입>" }],
  "triggers": { "crons": ["17 * * * *", "0 18 * * *", "30 18 * * SUN"] },
  "vars": {
    "APP_ORIGIN": "https://domain.b-cube.kr",
    "ZONE_NAME": "b-cube.kr",
    "CF_ZONE_ID": "<사용자 제공>",
    "GOOGLE_CLIENT_ID": "<사용자 제공>",
    "ALLOWED_EMAIL_DOMAIN": "ajou.ac.kr",
    "REQUIRE_HD": "false",
    "ADMIN_EMAILS": "",
    "MAX_LEASES_PER_USER": "3",
    "LEASE_DAYS": "180",
    "RENEW_WINDOW_DAYS": "30",
    "NAME_HOLD_DAYS": "30",
    "HEALTH_GRACE_DAYS": "3",
    "HEALTH_FAIL_THRESHOLD": "7",
    "EXTRA_RESERVED_NAMES": "",
    "DNS_DRY_RUN": "false",
    "DEV_AUTH_DEBUG": "false",
    "DEV_FAKE_LOGIN": "false"
  }
}
```

- **시크릿** (`wrangler secret put`, 로컬은 `.dev.vars`): `GOOGLE_CLIENT_SECRET`, `CF_API_TOKEN`
- `env.ts`에서 모든 설정을 파싱하고 검증한다. 필수값이 없으면 기동 시 명확한 에러를 낸다.
  - 단, **개발 모드**(APP_ORIGIN이 `http://localhost:*`)에서는 필수 조건을 완화한다.
    - `DEV_FAKE_LOGIN=true`이면 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`이 비어 있어도 기동한다. 이때 `/auth/login`은 "OAuth 미설정 — 개발용 로그인을 사용하세요"라고 안내하는 화면을 보여준다.
    - `DNS_DRY_RUN=true`이면 `CF_API_TOKEN`/`CF_ZONE_ID`가 비어 있어도 기동한다.
  - **안전장치**: APP_ORIGIN이 localhost가 아닌데 `DEV_FAKE_LOGIN`, `DEV_AUTH_DEBUG`, `DNS_DRY_RUN` 중 하나라도 true이면 **모든 요청에 500을 반환**하고 원인을 로그에 남긴다. 운영 배포 실수를 막기 위해서다.
- `ADMIN_EMAILS`는 쉼표로 구분하며, 비교할 때 trim + 소문자로 정규화한다.
- 로컬 개발에서는 `APP_ORIGIN=http://localhost:5173`, `DNS_DRY_RUN=true`를 쓴다.

### 4.1 npm 스크립트 (package.json에 고정)

| 스크립트 | 동작 |
|---|---|
| `npm run dev` | `vite dev`: SPA(HMR) + Worker + 로컬 D1을 `http://localhost:5173`에서 실행 |
| `npm run build` | `vite build`: SPA와 Worker 번들 생성 |
| `npm run preview` | `vite build && vite preview`: 빌드 결과물을 Workers 런타임(workerd)에서 실행해 운영과 같은 동작 확인 |
| `npm run db:migrate:local` | `wrangler d1 migrations apply bcube-domain --local` |
| `npm run db:seed` | 로컬 D1에 시드 데이터 투입 (§4.3) |
| `npm run db:reset` | 로컬 D1 상태 삭제 → 마이그레이션 → 시드 (원클릭 초기화) |
| `npm run typecheck` | `tsc --noEmit`를 app(`src`, `shared`), worker(`worker`, `shared`, `test`), node(설정 파일, `scripts`) tsconfig 3개에 각각 실행 |
| `npm test` | Vitest 전체 실행 |
| `npm run deploy` | `vite build && wrangler deploy`. **실행 전 사용자 확인 필수** |

- `db:*` 스크립트는 **`--local`에만 작동**해야 한다. `--remote`로 시드를 넣는 스크립트는 만들지 않는다.

### 4.2 개발 전용 가짜 로그인 (`DEV_FAKE_LOGIN`)

Google OAuth 설정 없이 모든 화면과 권한 시나리오를 확인하기 위한 기능이다.

- **활성 조건**: `DEV_FAKE_LOGIN=true` **이고** APP_ORIGIN이 `http://localhost:*`일 때만 라우트를 **등록**한다. 조건을 만족하지 않으면 라우트 자체가 존재하지 않아 404가 난다. §4의 안전장치와 이중으로 막는다.
- `GET /auth/dev-login?as=<persona>`: 시드 사용자로 즉시 세션을 만들고 `/`로 리다이렉트한다. 세션 생성 경로는 실제 OAuth 콜백과 **같은 함수**를 재사용한다(쿠키 속성, 감사 로그 `auth.login`, detail에 `{ "dev": true }` 표시).
- 페르소나:

  | `as` | 이메일 | 용도 |
  |---|---|---|
  | `user` | `member1@ajou.ac.kr` | 일반 회원, lease 여러 상태 보유 |
  | `full` | `member2@ajou.ac.kr` | 한도(3개)에 도달한 회원 |
  | `new` | `newbie@ajou.ac.kr` | lease 없는 신규 회원 (빈 상태 화면) |
  | `admin` | `admin@ajou.ac.kr` | 관리자. 개발 모드에서는 `ADMIN_EMAILS`에 자동 포함 |
  | `banned` | `banned@ajou.ac.kr` | 차단 사용자 → 실제 로그인과 같은 거부 화면 확인용 |

  - 개발 모드에서 `admin` 페르소나를 `ADMIN_EMAILS`에 자동 포함하는 처리는 env 파싱 단계에서만 한다. 권한 검사 코드에는 개발용 분기를 넣지 않는다.
- **로그인 화면 UI**: 개발 모드일 때만 로그인 페이지 하단에 `InlineNotification(kind="warning")`으로 "개발 모드" 표시를 하고, 페르소나별 `Button(kind="ghost")` 목록을 보여준다. 프론트는 `/api/dev/config`(개발 모드에서만 존재)로 노출 여부를 판단한다. 운영 번들에는 페르소나 목록이 포함되지 않아야 한다.
- **화면 상단 배지**: 개발 모드에서는 Header에 `Tag(type="magenta") DEV` 배지를 항상 표시하고, `DNS_DRY_RUN=true`이면 `Tag DRY-RUN` 배지도 함께 표시한다.

### 4.3 시드 데이터 (`scripts/seed.sql` 또는 `scripts/seed.ts`)

`npm run db:seed`가 **멱등적으로**(다시 실행해도 같은 결과) 다음 데이터를 넣는다. 시간 값은 실행 시각 기준 상대값으로 계산한다. SQL 파일이라면 생성 스크립트로 만든다.

- **사용자**: §4.2의 페르소나 5명. `banned`는 `banned_at`과 `ban_reason`을 설정한다.
- **lease** (모든 `cf_record_id`는 `dry_` 접두사):

  | 소유자 | 이름 | target_kind | 상태 | 확인할 UI |
  |---|---|---|---|---|
  | member1 | `alice-blog` | vercel | active, 만료 120일 후 | 정상 행, 녹색 Tag |
  | member1 | `alice-api` | ip (A 2개 + AAAA 1개, proxied) | active, **만료 10일 후** | 만료 임박 배너, 연장 버튼 활성 |
  | member1 | `alice-old` | cname | **suspended** (health_fail_count=7) | 빨간 Tag, 재확인 안내 |
  | member1 | `alice-legacy` | vercel | **expired** (10일 전) | 회색 Tag, 이름 보류 |
  | member2 | `bob-1`, `bob-2`, `bob-3` | 혼합 | active | **한도 도달** → "새 서브도메인" 비활성 |
  | banned | `spam-site` | ip | **revoked** (사유: 피싱 신고) | 관리자 화면의 회수 이력 |

  - TXT 레코드 예시도 포함한다: `_vercel.b-cube.kr`(alice-blog의 검증값), `_acme-challenge.alice-api.b-cube.kr`
- **감사 로그**: 위 상태에 이르는 이력을 30~50건 정도 넣는다. 로그인/거부, 생성, 레코드 교체, 연장, health_fail, suspend, expire, admin.revoke, admin.ban을 포함하고, 시각은 최근 60일에 분산한다. 관리자 감사 로그 탭의 페이지네이션과 필터를 확인할 수 있는 양이어야 한다.
- **드리프트**: 최근 reconcile 결과 1건을 넣는다. Cloudflare에만 있는 레코드 1개와 내용이 다른 레코드 1개를 포함한다.
- 테스트 코드(§12)는 이 시드와 **독립된** 픽스처를 쓴다. 시드는 UI 확인 전용이다.

### 4.4 로컬 UI 확인 절차 (README에도 그대로 기재)

```bash
cp .dev.vars.example .dev.vars   # 기본값: DEV_FAKE_LOGIN=true, DNS_DRY_RUN=true, 시크릿 비움
npm install
npm run db:reset
npm run dev                      # → http://localhost:5173
```

`.dev.vars.example`의 기본값은 위 절차가 **OAuth 클라이언트나 Cloudflare 토큰 없이** 바로 동작하도록 정한다. 실제 Google 로그인을 시험할 때만 `GOOGLE_CLIENT_ID`/`SECRET`을 채운다.

## 5. 데이터 모델 (`migrations/0001_init.sql`)

```sql
CREATE TABLE users (
  email          TEXT PRIMARY KEY,          -- 소문자 정규화
  google_sub     TEXT NOT NULL UNIQUE,
  name           TEXT,
  first_login_at INTEGER NOT NULL,          -- unix ms
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
  id                   TEXT PRIMARY KEY,    -- ulid/uuid
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
  host          TEXT NOT NULL,              -- FQDN: 'alice.b-cube.kr', '_vercel.b-cube.kr' 등
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
  action       TEXT NOT NULL,               -- 아래 목록 참고
  lease_id     TEXT,
  target_email TEXT,
  detail       TEXT,                        -- JSON (변경 전/후 값 등)
  ip           TEXT,                        -- CF-Connecting-IP
  user_agent   TEXT
);
CREATE INDEX idx_audit_at ON audit_logs(at);
CREATE INDEX idx_audit_lease ON audit_logs(lease_id);
CREATE INDEX idx_audit_actor ON audit_logs(actor_email);

-- 드리프트 점검(reconcile) 실행 결과 (§10.3). 관리자 드리프트 탭은 최근 1건을 보여준다.
CREATE TABLE reconcile_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  ok           INTEGER NOT NULL,            -- 1이면 Cloudflare 조회 성공
  drift_count  INTEGER NOT NULL,
  items        TEXT NOT NULL,               -- JSON 배열 (cf_only / db_only / mismatch)
  error        TEXT
);
CREATE INDEX idx_reconcile_at ON reconcile_runs(at);
```

- `migrations/0002_suspended_at.sql`: `leases.suspended_at INTEGER` (suspended로 바뀐 시각). §10.2의 "suspended 상태로 `NAME_HOLD_DAYS` 경과" 판단에 쓴다.

**감사 로그 action 목록**: `auth.login`, `auth.login_denied`, `auth.logout`, `lease.create`, `lease.update_records`, `lease.renew`, `lease.release`, `lease.recheck`, `lease.reactivate`, `system.health_fail`, `system.suspend`, `system.expire`, `admin.revoke`, `admin.ban`, `admin.unban`, `system.drift_detected`

## 6. 인증 및 세션

### 6.1 Google OAuth (Authorization Code + PKCE)

- `GET /auth/login`
  - `state`, `nonce`, `code_verifier`를 생성한다.
  - 이 값들을 `__Host-bcd_oauth` 쿠키에 담는다. 쿠키는 HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age 600이다. 서명하거나 암호화하거나 D1에 저장해도 된다.
  - 다음 주소로 리다이렉트한다: `https://accounts.google.com/o/oauth2/v2/auth`
  - 파라미터: `scope=openid email profile`, `hd=<ALLOWED_EMAIL_DOMAIN>`(UI 힌트일 뿐, 검증 아님), `prompt=select_account`
- `GET /auth/callback`
  1. `state`가 일치하는지 확인하고, 코드를 토큰으로 교환한다(`code_verifier` 포함).
  2. `id_token`을 `jose`와 Google JWKS(`https://www.googleapis.com/oauth2/v3/certs`)로 검증한다.
     - `iss`가 `https://accounts.google.com` 또는 `accounts.google.com`인지
     - `aud`가 `GOOGLE_CLIENT_ID`인지
     - `exp`가 유효한지, `nonce`가 일치하는지
  3. **허용 규칙**
     - `email_verified === true`이고 이메일(소문자)이 `@${ALLOWED_EMAIL_DOMAIN}`로 끝나야 한다.
     - `REQUIRE_HD=true`이면 `hd === ALLOWED_EMAIL_DOMAIN`도 만족해야 한다.
     - **예외**: `ADMIN_EMAILS`에 있는 이메일은 `email_verified`만 확인하고 도메인 검사를 면제한다.
     - `users.banned_at`이 설정된 사용자는 거부한다.
     - 거부할 때는 `auth.login_denied`를 감사 로그에 남기고, 로그인 페이지에 사유를 표시한다.
  4. users를 upsert하고 세션을 생성한 뒤 `/`로 리다이렉트한다.
- `DEV_AUTH_DEBUG=true`이고 `APP_ORIGIN`이 localhost일 때만 `/auth/debug` 페이지를 연다. 이 페이지는 마지막 로그인의 ID 토큰 클레임(`email`, `email_verified`, `hd`)을 보여준다. 운영에서는 라우트 자체를 등록하지 않는다.

### 6.2 세션 쿠키 (쿠키 공유 리스크 대응)

- 이름은 **`__Host-bcd_session`** 이다. `__Host-` 접두사를 쓰면 `Domain` 속성을 붙일 수 없으므로, 형제 서브도메인이 이 쿠키를 덮어쓰는 공격(cookie tossing)이 막힌다.
- 속성: `HttpOnly; Secure; SameSite=Lax; Path=/`, **`Domain` 속성 없음**, 만료 7일.
- 쿠키 값은 32바이트 랜덤 토큰이고, DB에는 SHA-256 해시만 저장한다.
- 로그아웃하면 DB에서 세션을 삭제하고 쿠키를 만료시킨다.
- 로컬 개발(http)에서는 `__Host-`와 Secure를 쓸 수 없으므로 `bcd_session`으로 대체한다. 이 분기는 APP_ORIGIN이 localhost일 때만 허용한다.

### 6.3 CSRF (중요)

`*.b-cube.kr`의 모든 서브도메인은 콘솔과 **same-site**다. 따라서 SameSite 쿠키만으로는 동아리원 서브도메인에서 오는 요청을 막을 수 없다. 상태를 바꾸는 모든 요청(POST/PATCH/PUT/DELETE)에 대해 다음 두 가지를 **모두** 검사한다.

1. `Origin` 헤더가 `APP_ORIGIN`과 정확히 일치해야 한다. 헤더가 없으면 거부한다.
2. `X-CSRF-Token` 헤더가 세션의 `csrf_token`과 일치해야 한다. 비교는 상수 시간으로 한다.

`GET /api/me`가 `csrfToken`을 반환하고, 프론트의 `api/client.ts`가 이 값을 자동으로 첨부한다.

### 6.4 보안 헤더 (모든 응답)

- `Content-Security-Policy`: `default-src 'self'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com`
  - Carbon은 셀프 호스팅, 폰트는 jsDelivr CDN(`cdn.jsdelivr.net`)에서 불러오는 기준이다. 필요하면 조정하고 보고한다.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`
- API 응답에는 `Cache-Control: no-store`를 붙인다.

### 6.5 권한

- `requireUser`: 세션이 유효해야 하고 사용자가 차단 상태가 아니어야 한다. 세션이 살아 있어도 차단되면 즉시 401을 반환한다.
- `requireAdmin`: `requireUser`를 통과하고, 이메일이 `ADMIN_EMAILS`에 있어야 한다. 아니면 403을 반환한다.
- 일반 사용자는 **자신의 lease만** 조회하고 수정할 수 있다. 남의 lease id로 요청하면 404를 반환한다(존재 여부를 노출하지 않기 위해).

## 7. 검증 규칙 (`shared/rules.ts`, 순수 함수 + 단위 테스트 필수)

### 7.1 서브도메인 이름 (예약어 차단)

- 정규식은 `^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$`이다. 길이 3~32자, 소문자, 숫자, 하이픈만 허용한다.
- 다음은 금지한다.
  - `--` 연속 하이픈 (`xn--` 퓨니코드 포함)
  - 숫자로만 된 이름
  - `_`로 시작하는 이름
- **예약어** (`worker/data/reserved-names.ts`) + `EXTRA_RESERVED_NAMES`(쉼표 구분)를 막는다. 기본 목록:
  ```
  www, domain, api, admin, administrator, root, mail, email, smtp, imap, pop, pop3, mx, ns, ns1, ns2, dns,
  ftp, sftp, ssh, vpn, git, gitlab, github, gitea, blog, docs, doc, wiki, status, cdn, static, assets,
  media, img, auth, login, logout, signin, signup, sso, oauth, account, accounts, id, my, console,
  dashboard, panel, support, help, abuse, postmaster, hostmaster, webmaster, security, noreply,
  b-cube, bcube, ajou, official, notice, test, dev, staging, prod, localhost, autoconfig,
  autodiscover, wpad, isatap, _dmarc, _domainkey
  ```
- **금칙어** (`worker/data/banned-words.ts`): 욕설이나 사칭성 단어(예: `kakao`, `naver`, `google`, `bank`, `paypal`, `ajou-portal` 등)가 **부분 문자열**로 포함되면 거부한다. 목록은 관리자가 코드로 수정한다.
- **동적 충돌 검사**: 생성 시점에 Cloudflare API로 `<name>.b-cube.kr`과 `*.<name>.b-cube.kr`에 기존 레코드가 있는지 조회한다. 이 앱이 관리하지 않는 레코드가 있으면 거부한다.
- **이름 보류**: expired, revoked, released 상태가 된 지 `NAME_HOLD_DAYS` 이내인 이름은 다음과 같이 처리한다.
  - expired, released: 원래 소유자만 다시 신청할 수 있다.
  - revoked: 누구도 신청할 수 없다.

### 7.2 허용 레코드 타입과 구성

허용 타입은 **A, AAAA, CNAME, TXT** 뿐이다. NS, MX, SRV, CAA, 와일드카드 등은 전부 거부한다.

lease 하나(`alice`)의 레코드 구성 규칙:

| target_kind | 본 레코드(`alice.b-cube.kr`) | 추가 허용 TXT |
|---|---|---|
| `vercel` | CNAME 1개, 기본값 `cname.vercel-dns.com` (사용자가 Vercel이 안내한 다른 `*.vercel-dns.com` 또는 `*.vercel-dns-<숫자>.com` 값으로 변경 가능) | `_vercel.b-cube.kr` TXT (아래 규칙) |
| `ip` | A 최대 2개 + AAAA 최대 2개 (최소 1개) | `alice.b-cube.kr` TXT, `_acme-challenge.alice.b-cube.kr` TXT |
| `cname` | CNAME 1개 | `_acme-challenge.alice.b-cube.kr` TXT |

- Vercel 프로젝트별 CNAME 값은 `d1d4fc829fe7bc7c.vercel-dns-017.com` 형태다(Vercel 문서, 2026-10 확인).

공통 제한:
- 레코드 입력의 `host`는 FQDN으로 받는다(예: `alice.b-cube.kr`, `_vercel.b-cube.kr`, `_acme-challenge.alice.b-cube.kr`). 대소문자와 끝의 점은 정규화한다.
- CNAME이 있는 host에는 다른 레코드를 둘 수 없다(DNS 규칙).
- lease당 TXT는 최대 5개, 값은 최대 512자이며 출력 가능한 ASCII만 허용한다.
- **Vercel 검증 TXT**: host는 `_vercel.b-cube.kr`(존 루트)다. 값은 반드시 `vc-domain-verify=alice.b-cube.kr,`로 시작해야 하며, 자기 lease의 FQDN만 허용한다. 이 레코드는 여러 회원의 값이 같은 host에 공존하므로 **해당 record id 단위로만 삭제**한다.
  - Vercel 문서(2026-10 확인)는 위치(`_vercel.<apex>`)와 여러 값의 공존만 명시하고 값 형식은 명시하지 않는다. 위 형식을 유지한다.
- **A/AAAA 값**: 유효한 공인 IP만 허용한다. 아래 대역은 거부한다.
  - IPv4: `0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32`
  - IPv6: `::/128, ::1/128, ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8, 2001:db8::/32`
- **CNAME 값**: 유효한 FQDN(라벨 규칙, 길이 253자 이하)이어야 한다.
  - IP 형태는 금지한다.
  - `b-cube.kr`이나 그 하위 도메인을 가리키는 것은 금지한다. 회원 간 체인과 탈취 연쇄를 막기 위해서다.
  - 끝의 점은 정규화해서 제거한다.
- **proxied**: 기본값은 false다. `ip` 타입의 A/AAAA에서만 사용자가 켤 수 있다. Vercel과 CNAME은 항상 false로 강제한다. TXT는 항상 false다.
- TTL은 Cloudflare 자동값(1)으로 고정한다.

## 8. Cloudflare DNS 서비스 (`services/cloudflare-dns.ts`)

- Base URL은 `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`이고, `Authorization: Bearer ${CF_API_TOKEN}` 헤더를 붙인다.
- 제공 함수: `listByName(fqdn)`, `create(record)`, `update(id, record)`, `remove(id)`, `listManaged()`
- 레코드 **comment**에는 `bcd:lease=<leaseId>`를 기록한다. 짧게 유지하고 이메일 등 개인정보는 넣지 않는다. 무료 플랜의 comment 길이 제한은 구현 시 확인한다.
- `DNS_DRY_RUN=true`이면 네트워크를 호출하지 않고 `dry_<uuid>` id를 반환하며 콘솔 로그만 남긴다.
- 실패하면 Cloudflare 오류 메시지를 사용자에게 그대로 노출하지 않는다. 일반화한 메시지로 응답하고 상세 내용은 서버 로그에만 남긴다.
- **일관성 보장**
  - 레코드 세트를 교체할 때는 순서를 지킨다: 1) 새 레코드 생성 → 2) DB 갱신 → 3) 기존 레코드 삭제.
  - 중간에 실패하면 생성한 것을 롤백한다. 그래도 남는 불일치는 reconcile cron이 감지한다.
  - D1 batch로 DB 갱신을 원자적으로 처리한다.
  - 내용이 같은 레코드는 건드리지 않는다. CNAME은 같은 host에 둘 이상 둘 수 없어 "생성 후 삭제"가 불가능하므로 기존 레코드를 수정(PATCH)하고, 실패하면 원래 값으로 되돌린다.
  - 3) 기존 레코드 삭제가 실패해도 작업은 성공으로 응답한다. 남은 레코드는 드리프트 점검이 감지한다.

## 9. API 명세

모든 응답은 JSON이고, 에러 형식은 `{ error: { code, message } }`다. 입력은 zod로 검증한다.

- 레코드 검증 실패(400 `invalid_records`)에는 `error.errors: [{ index?, code, message }]`(입력 순번별 오류)가 붙는다.
- 이름은 trim 후 소문자로 정규화해 검사한다. 이름 오류 코드는 형식·예약어·금칙어면 400, `taken`·`held`·`conflict`면 409다.
- Cloudflare 실패는 502 `dns_error`(일반화한 메시지)다.

### 인증
| Method | Path | 설명 |
|---|---|---|
| GET | `/auth/login` | Google 로그인 시작 |
| GET | `/auth/callback` | 콜백 |
| POST | `/auth/logout` | 로그아웃 (CSRF 적용) |

### 사용자
| Method | Path | 설명 |
|---|---|---|
| GET | `/api/me` | `{ email, name, isAdmin, csrfToken, zone, limits: { max, used } }`. `zone`은 `ZONE_NAME`(예: `b-cube.kr`)이며 화면에서 FQDN을 표시할 때 쓴다 |
| GET | `/api/names/:name/availability` | `{ available, reason? }`. 이유 코드: `invalid_format`, `reserved`, `banned_word`, `taken`, `held`, `conflict` |
| GET | `/api/leases` | 내 lease 목록 (records 포함) |
| GET | `/api/leases/:id` | 상세 + 해당 lease의 감사 로그 |
| POST | `/api/leases` | `{ name, targetKind, records[] }` → 생성. **1인당 한도**: active+suspended 개수가 `MAX_LEASES_PER_USER` 이상이면 409 `limit_reached` |
| PUT | `/api/leases/:id/records` | 레코드 세트 전체 교체. active 상태에서만 가능 |
| POST | `/api/leases/:id/renew` | 만료 `RENEW_WINDOW_DAYS` 이내일 때만 가능. `expires_at = now + LEASE_DAYS` |
| POST | `/api/leases/:id/recheck` | 즉시 헬스체크. suspended 상태에서 통과하면 레코드를 재생성하고 active로 전환 |

`renew`, `recheck`, `DELETE`는 active와 suspended에서 가능하다(그 외 409). `recheck`는 lease당 1분에 1회(429 `recheck_too_soon`)이며 실패해도 `health_fail_count`를 올리지 않는다(누적은 cron만 한다). suspended의 재확인은 DNS 레코드가 없으므로 CNAME 대상의 DoH 조회(IP는 TCP 연결)만 한다. 소유자에게 보여주는 lease 감사 로그(`GET /api/leases/:id`)는 최근 100건이며 작업자 이메일과 IP를 숨긴다.

| DELETE | `/api/leases/:id` | 반납. Cloudflare 레코드 삭제 → status `released` |

### 관리자 (남용 대응)
| Method | Path | 설명 |
|---|---|---|
| GET | `/api/admin/leases?status=&q=&page=` | 전체 lease (이름/소유자 검색) |
| POST | `/api/admin/leases/:id/revoke` | `{ reason }` 필수. 강제 회수 → Cloudflare 삭제, status `revoked` |
| GET | `/api/admin/users?q=&banned=` | 사용자 목록, 보유 lease 수 |
| POST | `/api/admin/users/:email/ban` | `{ reason }` 필수. 차단 → 해당 사용자의 세션 전부 삭제, 모든 active·suspended lease를 revoke(사유: `user_banned`). suspended를 남기면 차단된 사용자가 이름을 계속 점유하기 때문이다. 자기 자신은 차단할 수 없다(400 `cannot_ban_self`) |
| POST | `/api/admin/users/:email/unban` | 차단 해제 (revoke된 lease는 복구하지 않음) |
| GET | `/api/admin/audit-logs?actor=&action=&lease=&from=&to=&page=` | 감사 로그 조회 |
| GET | `/api/admin/drift` | 최근 reconcile 결과 |

**모든 상태 변경 API는 감사 로그를 남긴다.** detail에는 변경 전/후 레코드를 기록한다.

## 10. 서브도메인 탈취 방지 (Cron)

### 10.1 만료 처리: 매일 `0 18 * * *` (KST 03:00)
- `status='active' AND expires_at < now`인 lease → Cloudflare 레코드 삭제, `status='expired'`, `ended_at=now`, 감사 로그 `system.expire`
- 만료 `RENEW_WINDOW_DAYS` 이내인 lease는 UI 상단에 경고 배너를 띄운다(별도 알림 발송 없음).
- `expires_at <= now`인 `sessions` 행을 삭제한다. 만료 세션은 조회 단계에서 이미 거부되므로 테이블 정리 목적이다.

### 10.2 헬스체크: 매시 `17 * * * *`
- Workers 서브요청 한도를 고려해 매 실행마다 `last_health_check_at`이 가장 오래된 active lease **최대 10개**만 처리한다.
- 각 lease는 하루 1회 이상 검사되면 충분하다. 24시간 이내에 검사한 lease는 건너뛴다.
- 생성 후 `HEALTH_GRACE_DAYS` 이내 lease는 검사는 하되 실패 횟수를 세지 않는다.
- **판정 로직** (`services/health.ts`):
  - **CNAME 계열(vercel/cname)**
    1. DoH(`https://cloudflare-dns.com/dns-query`, `accept: application/dns-json`)로 CNAME 대상의 A/AAAA를 조회한다. NXDOMAIN이거나 응답이 없으면 → 실패.
    2. `https://<name>.b-cube.kr/`에 GET 요청한다(`redirect: manual`, 타임아웃 10초).
       - 응답이 오면 상태코드와 무관하게 정상이다.
       - 단, **벤더별 "주인 없음" 신호**는 실패로 판정한다.
         - Vercel: 응답 헤더 `x-vercel-error`가 `DEPLOYMENT_NOT_FOUND` 또는 `NOT_FOUND` 계열
         - Netlify: 404이면서 `x-nf-request-id`가 있고 사이트 미존재 페이지인 경우
         - GitHub Pages: 404이면서 "There isn't a GitHub Pages site here" 페이지인 경우
       - 각 신호는 구현 시 실제 응답으로 확인하고, 벤더 시그니처는 하나의 테이블로 관리한다.
  - **IP 계열(ip)**: `cloudflare:sockets`의 `connect()`로 각 IP의 443 포트, 실패하면 80 포트에 TCP 연결을 시도한다(타임아웃 5초). 하나라도 성공하면 정상이다.
- **결과 처리**
  - 성공하면 `health_fail_count=0`, `last_health_ok_at=now`
  - 실패하면 `health_fail_count++`, 감사 로그 `system.health_fail`. 같은 날 중복 기록은 하지 않는다.
  - `health_fail_count >= HEALTH_FAIL_THRESHOLD`가 되면 **suspend**한다.
    - Cloudflare 레코드를 삭제하고, DB records는 유지하되 `cf_record_id=NULL`로 바꾼다.
    - `status='suspended'`, `status_reason='health_check_failed'`, 감사 로그 `system.suspend`
  - suspended 상태의 이름은 소유자에게 유지된다. 소유자가 "재확인"을 눌러 통과하면 레코드를 재생성하고 다시 active로 전환한다.
  - suspended 상태로 `NAME_HOLD_DAYS`가 지나면 → `expired`로 전환한다.
    - 이 전환과 "suspended인데 `expires_at`이 지난 lease"의 만료는 매일 만료 cron(§10.1)에서 처리한다. `status_reason`은 `lease_expired` 또는 `suspended_too_long`이다.
  - 실패 횟수와 `system.health_fail` 기록은 KST 기준 하루 1회다.

### 10.3 드리프트 점검: 매주 `30 18 * * SUN`
- Cloudflare에서 comment가 `bcd:lease=`인 레코드 목록과 DB records를 비교한다.
- Cloudflare에만 있거나, DB에만 있거나, 내용이 다른 레코드를 감지하면 감사 로그 `system.drift_detected`에 남기고 관리자 드리프트 탭에 표시한다.
- **자동 삭제는 하지 않는다.**
- Cloudflare cron은 요일 `0`을 받지 않는다(1–7 또는 `SUN`–`SAT`, 1=일요일). 그래서 `SUN`으로 쓴다.
- `DNS_DRY_RUN=true`에서는 Cloudflare를 조회하지 않으므로 결과에 그 사실을 `error` 문구로 남긴다(모든 레코드가 DB에만 있음으로 나온다).

`scheduled` 핸들러는 `controller.cron` 값으로 위 세 작업을 분기한다.

## 11. 프론트엔드 (IBM Carbon)

- 패키지: `@carbon/react`, `@carbon/styles`, `@carbon/icons-react`
- 테마: 기본 `g10`, `prefers-color-scheme: dark`이면 `g100` (`<Theme>` 사용)
- 폰트: IBM Plex Sans KR. `index.html`에서 jsDelivr의 `@fontsource/ibm-plex-sans-kr@5.3.0`(버전 고정)을 불러온다. 한국에서 jsDelivr는 Cloudflare 서울 엣지로 응답해 Google Fonts(`fonts.gstatic.com`)보다 빠르다(2026-10-28 측정: woff2 응답 약 35ms 대 170ms)
- 코드 표시 폰트: D2Coding. `index.html`에서 jsDelivr의 `d2coding@1.3.2` subset(KS X 1001 한글 2,350자, woff2 약 350kB)을 불러온다
- 레이아웃: **UI Shell** `Header`(이름 "B-CUBE Domain"), `HeaderNavigation`(내 서브도메인 / 관리자는 "관리"), `HeaderGlobalAction`(로그아웃). 본문은 `Grid`/`Column`.
- 모바일 폭에서도 사용 가능해야 한다.

### 페이지
1. **로그인** (`/login`): `Tile`과 안내 문구("@ajou.ac.kr 계정만 이용 가능"), `Button` "Google로 로그인". 거부 사유는 `InlineNotification`으로 표시.
2. **내 서브도메인** (`/`)
   - `DataTable` 컬럼: 이름(링크), 연결 대상, 상태(`Tag`: active=green, suspended=red, expired=gray), 만료일, 마지막 헬스체크, 작업(`OverflowMenu`: 편집/연장/재확인/반납)
   - 상단 `Button` "새 서브도메인". 한도에 도달하면 비활성화하고 사유를 툴팁으로 보여준다.
   - 만료 임박이나 suspended 상태면 `ActionableNotification`으로 안내한다.
3. **새 서브도메인** (`/new`): `ProgressIndicator` 4단계
   1. 이름: `TextInput` + 300ms 디바운스로 가용성 조회, 결과는 `invalid`/`helperText`로 표시
   2. 연결 대상: `RadioTile` 3종 (Vercel / 서버 IP(AWS 등) / 기타 CNAME). 각각 짧은 설명 포함
   3. 레코드 입력: 대상별 폼. Vercel은 CNAME 값이 미리 채워지고 검증 TXT 입력란은 선택. IP는 A/AAAA 동적 추가. 프록시 `Toggle`은 IP일 때만 노출
   4. 확인: 생성될 레코드 미리보기(`StructuredList`) → 생성
   - 생성 후 대상별 **연결 가이드**를 표시한다. 예: Vercel 프로젝트 → Settings → Domains에서 `alice.b-cube.kr` 추가
4. **상세** (`/leases/:id`): 레코드 목록, 편집 폼(위 3단계 재사용), 헬스 상태, 이 lease의 감사 로그 타임라인
   - 반납은 `Modal danger`를 띄우고, 이름을 직접 입력해야 버튼이 활성화된다.
5. **관리** (`/admin`): `Tabs` 4개
   - **전체 임대**: 검색/필터 `DataTable`, 행별 "강제 회수"(사유 `TextArea` 필수인 Modal)
   - **사용자**: 검색, 보유 수, 차단/해제(사유 필수)
   - **감사 로그**: 필터(작업자/액션/기간), 페이지네이션, detail JSON 펼쳐보기
   - **드리프트**: 최근 reconcile 결과
- 모든 폼은 `shared/schemas.ts`의 zod 스키마로 클라이언트에서 먼저 검증하고, 서버에서 다시 검증한다.
- 에러는 `ToastNotification`, 로딩은 `DataTableSkeleton`/`InlineLoading`으로 처리한다.

## 12. 테스트

- **단위**: `shared/rules.ts`의 모든 규칙
  - 이름 정규식, 예약어, 금칙어, IP 사설 대역 경계값, CNAME 정규화와 금지 대상, 레코드 구성 조합, Vercel TXT 값 형식
- **테스트 환경**: `vitest.config.ts`를 `vite.config.ts`와 분리한다(`cloudflare()` 플러그인 충돌 방지). Workers 런타임 테스트 패키지는 `@cloudflare/vitest-pool-workers`의 후속인 `@cloudflare/vitest-plugin`을 쓴다. 바인딩은 개인 `.dev.vars`와 무관하게 설정 파일에 고정하고, 각 테스트 파일 실행 전에 D1 마이그레이션을 적용한다.
- **통합** (Workers 런타임, D1 로컬, Cloudflare/Google API는 fetch mock):
  - 로그인 허용/거부(도메인, `email_verified`, hd, 관리자 예외, 차단 사용자)
  - CSRF: Origin 누락, 다른 서브도메인 Origin, 토큰 불일치 → 403
  - 1인당 한도, 남의 lease 접근 → 404, 일반 사용자의 admin API 접근 → 403
  - lease 생성/교체/반납 시 Cloudflare 호출 순서와 롤백
  - 차단 시 세션 삭제와 lease 일괄 revoke
  - 헬스체크 실패 누적 → suspend → recheck로 복구
  - 만료 cron, 이름 보류 규칙
  - **개발 기능 차단**:
    - APP_ORIGIN이 운영 주소이면 `/auth/dev-login`, `/api/dev/config`, `/auth/debug`가 404인지
    - 운영 주소에서 `DEV_FAKE_LOGIN`/`DEV_AUTH_DEBUG`/`DNS_DRY_RUN` 중 하나라도 true이면 모든 요청이 500인지
    - `dev-login?as=banned`가 실제 로그인과 같은 거부 흐름을 타는지
- 모든 상태 변경 경로에 감사 로그가 남는지 검증한다.

## 13. 마일스톤

| # | 내용 | 완료 기준 |
|---|---|---|
| M1 | 프로젝트 골격: Vite + Cloudflare 플러그인 + Hono + React/Carbon, wrangler.jsonc, `.dev.vars.example`, D1 마이그레이션, env 파싱(개발 모드 완화 + 안전장치), npm 스크립트(§4.1), 세션 기반 + **개발 전용 가짜 로그인**(§4.2), **시드 스크립트**(§4.3), DEV/DRY-RUN 배지 | **OAuth 클라이언트와 Cloudflare 토큰이 없는 상태에서** §4.4 절차만으로 `npm run dev` → 로그인 화면의 페르소나 버튼으로 로그인 → Carbon 셸(Header, 배지, 로그아웃)과 `/api/health`, `/api/me` 응답 확인. `npm run preview`도 같은 방식으로 동작 |
| M2 | Google OAuth, CSRF, 보안 헤더, `/auth/debug`(개발 전용). 가짜 로그인과 세션 생성 함수 공유 | 로컬 로그인 성공/거부 테스트 통과, 개발 기능 차단 테스트 통과 |
| M3 | `shared/rules.ts` + 단위 테스트 | 규칙 테스트 전부 통과 |
| M4 | Cloudflare DNS 서비스(dry-run) + lease API + 감사 로그 | 통합 테스트 통과 |
| M5 | 사용자 UI (목록/생성/상세/반납) | `DNS_DRY_RUN=true` + 가짜 로그인 + 시드 상태에서, **OAuth·Cloudflare 토큰 없이** 다음을 모두 화면으로 확인: ① `user`: 상태별 Tag 4종, 만료 임박 배너, suspended 재확인 안내, 생성 4단계 흐름(대상 3종), 상세·편집·연장·반납 ② `full`: 새 서브도메인 버튼 비활성과 툴팁 ③ `new`: 빈 상태 화면 ④ `banned`: 로그인 거부 화면 ⑤ 모바일 폭(375px) 레이아웃. 확인한 화면 목록을 보고에 포함 |
| M6 | 관리자 API + UI (회수/차단/감사 로그/드리프트) | 통합 테스트 통과 + `admin` 페르소나와 시드로 4개 탭(회수 이력, 차단 사용자, 감사 로그 필터·페이지네이션, 드리프트 2건) 화면 확인 |
| M7 | Cron 3종 (만료/헬스/드리프트) | 로컬 `scheduled` 트리거 테스트 통과 |
| M8 | README(로컬 실행, 배포 절차, 운영 가이드), 배포 준비 | **사용자 확인 후** remote 마이그레이션과 deploy |

## 14. 범위 밖 (이번에 구현하지 않음)

- 이메일/메신저 알림
- 2단계 이상 서브도메인(`a.b.b-cube.kr`), 와일드카드
- MX/NS 위임
- 사용자 간 lease 양도
- 결제 및 과금
