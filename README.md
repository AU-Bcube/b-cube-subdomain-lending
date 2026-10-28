# B-CUBE Domain Console

아주대 동아리 B-CUBE 회원(@ajou.ac.kr Google 계정)이 `<name>.b-cube.kr` 서브도메인을 빌려 Vercel, 서버 IP(AWS 등), 기타 CNAME 대상에 연결하는 웹 콘솔입니다.

- 주소: `https://domain.b-cube.kr`
- 구성: Cloudflare Workers 하나 (Hono API + React/Carbon SPA + Cron), D1, Cloudflare DNS API
- 명세: [docs/SPEC.md](docs/SPEC.md) · 진척: [docs/PROGRESS_REPORT.md](docs/PROGRESS_REPORT.md) · 제한점: [docs/LIMITATIONS.md](docs/LIMITATIONS.md) · 수동 작업: [docs/01-manual-checklist.md](docs/01-manual-checklist.md)

## 로컬 실행

OAuth 클라이언트와 Cloudflare 토큰 없이 바로 동작합니다.

```bash
cp .dev.vars.example .dev.vars   # 기본값: DEV_FAKE_LOGIN=true, DNS_DRY_RUN=true, 시크릿 비움
npm install
npm run db:reset
npm run dev                      # → http://localhost:5173
```

로그인 화면 하단의 개발용 버튼으로 시드 사용자에 로그인합니다.

| 페르소나 | 이메일 | 확인할 화면 |
|---|---|---|
| 일반 회원 | `member1@ajou.ac.kr` | 상태별 Tag, 만료 임박 배너, 일시 중지 재확인 안내, 상세·편집·연장·반납 |
| 한도 도달 | `member2@ajou.ac.kr` | "새 서브도메인" 비활성과 툴팁 |
| 신규 회원 | `newbie@ajou.ac.kr` | 빈 상태 화면, 생성 4단계 흐름 |
| 관리자 | `admin@ajou.ac.kr` | 관리 탭 4개 |
| 차단 사용자 | `banned@ajou.ac.kr` | 로그인 거부 화면 |

> 시드의 `member1`은 사용 중 2개 + 일시 중지 1개로 이미 한도(3개)에 도달해 있습니다. 생성 흐름은 `newbie`로 확인하세요.

### 실제 Google 로그인 시험

`.dev.vars`에 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`을 채웁니다. Google 클라이언트의 리디렉션 URI에 `http://localhost:5173/auth/callback`이 있어야 합니다. `DEV_AUTH_DEBUG=true`이면 `/auth/debug`에서 마지막 로그인의 `email`, `email_verified`, `hd`를 볼 수 있습니다.

### 실제 Cloudflare DNS 시험

`DNS_DRY_RUN=false`와 `CF_ZONE_ID`, `CF_API_TOKEN`을 채우면 로컬에서도 **실제 b-cube.kr DNS가 바뀝니다.** 시드 레코드의 `dry_…` id는 Cloudflare에 없으므로, 실제 모드로 바꾼 뒤에는 새로 만든 lease로 시험하세요.

### Cron 수동 실행

dev 서버가 떠 있을 때 다음 주소로 각 작업을 실행할 수 있습니다.

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"   # 헬스체크
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=0+18+*+*+*"   # 만료 처리 + 만료 세션 삭제
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=30+18+*+*+SUN"  # 드리프트 점검
```

`DNS_DRY_RUN=true`에서는 드리프트 점검이 Cloudflare를 조회하지 않으므로 모든 레코드가 "DB에만 있음"으로 나옵니다.

## npm 스크립트

| 스크립트 | 동작 |
|---|---|
| `npm run dev` | SPA(HMR) + Worker + 로컬 D1 (`http://localhost:5173`) |
| `npm run build` | SPA와 Worker 번들 생성 |
| `npm run preview` | 빌드 결과를 workerd에서 실행. 코드를 바꾸면 다시 실행해야 반영됩니다 |
| `npm run db:migrate:local` | 로컬 D1 마이그레이션 |
| `npm run db:seed` | 로컬 D1 시드 (멱등) |
| `npm run db:reset` | 로컬 D1 삭제 → 마이그레이션 → 시드 |
| `npm run typecheck` | app / worker / node tsconfig 각각 `tsc --noEmit` |
| `npm test` | Vitest (Workers 런타임, 로컬 D1, 외부 API는 fetch mock) |
| `npm run cf-typegen` | `wrangler.jsonc` 변경 후 Worker 타입 재생성 |
| `npm run deploy` | `vite build && wrangler deploy` — **운영 배포** |

`db:*` 스크립트는 로컬 D1에만 작동합니다.

## 배포 절차 (운영)

아래 명령은 운영 환경을 바꿉니다. 순서대로, 각 단계 결과를 확인하며 직접 실행하세요.

1. Cloudflare 로그인: `npx wrangler login`
2. D1 생성: `npx wrangler d1 create bcube-domain` → 출력된 `database_id`를 `wrangler.jsonc`에 기입
3. `wrangler.jsonc`의 `vars` 기입: `CF_ZONE_ID`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`, `REQUIRE_HD`(체크리스트 7번 결과)
   - `APP_ORIGIN`은 `https://domain.b-cube.kr`, `DNS_DRY_RUN`·`DEV_FAKE_LOGIN`·`DEV_AUTH_DEBUG`는 모두 `"false"`여야 합니다. 하나라도 true면 모든 요청이 500이 됩니다(안전장치).
4. 시크릿 입력 (값은 터미널에 직접 입력):
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put CF_API_TOKEN
   ```
5. 원격 마이그레이션: `npx wrangler d1 migrations apply bcube-domain --remote`
6. 배포: `npm run deploy`
   - `routes`의 `custom_domain: true`로 `domain.b-cube.kr`이 Worker에 연결됩니다. 기존 `domain.b-cube.kr` DNS 레코드가 있으면 먼저 지워야 합니다.
7. 배포 후 확인: [docs/01-manual-checklist.md](docs/01-manual-checklist.md) 8번 체크리스트
   - `https://domain.b-cube.kr/api/health` → `{"status":"ok"}`
   - `/auth/dev-login?as=admin`, `/api/dev/config`, `/auth/debug`가 404
   - Workers 대시보드 → Triggers에 cron 3개

### 마이그레이션 추가

`migrations/000N_*.sql`을 추가하고 `npm run db:migrate:local`로 로컬에 적용합니다. 운영에는 배포 전에 `--remote`로 적용합니다. 컬럼 삭제처럼 되돌리기 어려운 변경은 백업(`wrangler d1 export bcube-domain --remote`) 후 진행하세요.

## 운영 가이드

### Cron

| cron (UTC) | KST | 작업 |
|---|---|---|
| `17 * * * *` | 매시 17분 | 헬스체크: 24시간 넘게 검사하지 않은 active lease 최대 10개. 하루(KST) 1회 실패 누적, 7일 연속 실패면 일시 중지 |
| `0 18 * * *` | 매일 03:00 | 만료 처리(만료된 active, 일시 중지 30일 경과), 만료 세션 삭제 |
| `30 18 * * SUN` | 월요일 03:30 | 드리프트 점검. 결과는 관리 → 드리프트 탭. **자동 삭제하지 않음** |

### 자주 하는 일

- **피싱·남용 신고**: 관리 → 전체 임대에서 강제 회수(사유 필수), 필요하면 사용자 탭에서 차단. 차단하면 세션이 모두 삭제되고 사용 중·일시 중지 lease가 일괄 회수됩니다. 회수한 이름은 30일간 누구도 신청할 수 없습니다.
- **드리프트 정리**: 드리프트 탭의 항목은 Cloudflare 대시보드에서 직접 확인하고 정리합니다.
  - "Cloudflare에만 있음": 이 앱의 comment(`bcd:lease=`)가 붙었지만 DB에 없는 레코드. 롤백 실패나 교체 후 삭제 실패로 남은 레코드일 가능성이 큽니다.
  - "DB에만 있음": DB는 있다고 믿지만 Cloudflare에 없는 레코드. 대시보드에서 수동 삭제된 경우입니다. 해당 lease를 반납·회수하거나 소유자가 레코드를 다시 저장하게 하세요.
  - "내용 다름": 대시보드에서 직접 수정된 레코드. 앱의 값이 기준입니다.
- **예약어 추가**: 코드 수정 없이 `EXTRA_RESERVED_NAMES`(쉼표 구분)에 넣고 배포합니다. 금칙어는 `worker/data/banned-words.ts`를 고칩니다.
- **관리자 변경**: `ADMIN_EMAILS` 수정 후 배포. 관리자 이메일은 도메인 검사를 면제받습니다(`email_verified`는 필요).
- **API 토큰 교체**: 만료 전에 새 토큰을 발급하고 `npx wrangler secret put CF_API_TOKEN`.

### 장애 시

- 모든 요청이 500 `config_error`: 설정 오류입니다. `npx wrangler tail`로 `[config]` 로그를 확인하세요. 운영에서 개발용 플래그가 켜진 경우가 대표적입니다.
- lease 작업이 502 `dns_error`: Cloudflare API 실패입니다. 상세 원인은 `[dns]` 로그에만 남습니다. 토큰 권한(Zone DNS Edit, Zone Read)과 만료를 확인하세요.
