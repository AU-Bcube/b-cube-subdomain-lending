# B-CUBE Domain Console

아주대 동아리 B-CUBE 회원(@ajou.ac.kr 계정)이 `<name>.b-cube.kr` 서브도메인을 빌려 Vercel, 서버 IP(AWS 등), 기타 CNAME 대상에 연결하는 웹 콘솔입니다.

- 주소: `https://domain.b-cube.kr`
- 구성: Netlify (React/Carbon SPA 정적 배포 + Functions의 Hono API + 예약 함수 3개), MongoDB, Cloudflare DNS API(`b-cube.kr` 존은 계속 Cloudflare에 있음)
- 명세: [docs/SPEC.md](docs/SPEC.md) · 진척: [docs/PROGRESS_REPORT.md](docs/PROGRESS_REPORT.md) · 제한점: [docs/LIMITATIONS.md](docs/LIMITATIONS.md) · 수동 작업: [docs/01-manual-checklist.md](docs/01-manual-checklist.md)

## 로컬 실행

MongoDB만 있으면 OAuth 클라이언트와 Cloudflare 토큰 없이 동작합니다. `.env`에 `DB_CONNECTION_STRING`과 `DB_NAME`을 넣으세요. 트랜잭션을 쓰므로 복제 세트(Atlas 또는 `--replSet`으로 띄운 mongod)가 필요합니다.

> **운영과 개발이 같은 DB를 씁니다(개발 DB를 따로 두지 않음).** `.env`의 Atlas DB가 곧 운영 DB이므로 로컬에서 하는 작업도 운영 데이터를 바꿉니다.
> - `db:seed -- --remote`: 가짜 사용자와 lease가 운영 DB에 들어갑니다. 실행하지 마세요.
> - `DEV_FAKE_LOGIN=true`: 가짜 페르소나 계정이 운영 DB에 생깁니다.
> - `DNS_DRY_RUN=true`로 만든 lease: 가짜 레코드 id(`dry_…`)가 운영 DB에 남아, 운영 cron이 실제 DNS 레코드를 다시 만들 수 있습니다.
> - `DNS_DRY_RUN=false`로 만든 lease: 실제 `b-cube.kr` DNS가 바뀝니다.
>
> 화면만 확인하려면 `--replSet`으로 띄운 로컬 mongod를 잠시 `.env`에 넣으세요.

```bash
# Node 24, pnpm 12(package.json의 packageManager)를 씁니다. pnpm 10이 전역에 있으면 실행이 실패하니 corepack enable pnpm으로 맞춥니다.
cp .env.example .env   # 기본값: DEV_FAKE_LOGIN=true, DNS_DRY_RUN=true, 시크릿 비움. DB_*를 채운다
pnpm install
pnpm run db:reset       # localhost DB 전용: 컬렉션 삭제 → 인덱스 → 시드
pnpm run dev            # → http://localhost:5173
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

### 실제 IdP 로그인 시험

`.env`에 `IDP_CLIENT_SECRET`을 채웁니다(`IDP_ISSUER`, `IDP_CLIENT_ID` 기본값은 `worker/runtime.ts`에 있습니다). IdP에 등록한 클라이언트의 `redirect_uris`에 `http://localhost:5173/auth/callback`이 있어야 합니다. 로컬 IdP를 쓰려면 `.env`에 `IDP_ISSUER`를 덧붙입니다. `DEV_AUTH_DEBUG=true`이면 `/auth/debug`에서 마지막 로그인의 `email`, `email_verified`, 소학회 이름을 볼 수 있습니다.

로그인에는 환경 변수 `REQUIRED_SOHAKOE`(기본 `B-cube`, 대소문자 무시)에 적은 소학회의 이력이 필요합니다. IdP의 소학회 가입내역(`sohakoe_memberships`)에서 이름이 같은 항목을 찾습니다. 로컬은 `.env`, 운영은 Netlify 환경 변수로 바꾸고, 운영은 다시 배포해야 반영됩니다. `ADMIN_EMAILS`만 면제입니다. 개발용 가짜 로그인 페르소나는 이 소학회 회원으로 취급합니다.

동의 관리: 회원은 상단 메뉴의 "B-CUBE 통합 로그인 동의 관리"(`{IDP_ISSUER}/consents`, 운영은 `https://id.b-cube.kr/consents`)에서 SP별 제공 항목을 보고 동의를 철회합니다.

### 실제 Cloudflare DNS 시험

`DNS_DRY_RUN=false`와 `CF_ZONE_ID`, `CF_API_TOKEN`을 채우면 로컬에서도 **실제 b-cube.kr DNS가 바뀝니다.** 시드 레코드의 `dry_…` id는 Cloudflare에 없으므로, 실제 모드로 바꾼 뒤에는 새로 만든 lease로 시험하세요.

### Cron 수동 실행

`.env`의 DB에 대해 각 작업을 한 번 실행합니다. dev 서버는 띄우지 않아도 됩니다. 원격 DB에는 `pnpm run cron health --remote`처럼 `--remote`가 필요하고, `DNS_DRY_RUN=false`이면 **실제 DNS가 바뀔 수 있습니다.**

```bash
pnpm run cron health   # 헬스체크 + 끊긴 DNS 작업 복구
pnpm run cron daily    # 만료 처리 + 만료 세션 삭제
pnpm run cron drift    # 드리프트 점검
```

`DNS_DRY_RUN=true`에서는 드리프트 점검이 Cloudflare를 조회하지 않으므로 모든 레코드가 "DB에만 있음"으로 나옵니다.

## npm 스크립트

| 스크립트 | 동작 |
|---|---|
| `pnpm run dev` | SPA(HMR) + `/api/*`·`/auth/*`를 Netlify 함수 코드로 처리 + `.env`의 MongoDB (`http://localhost:5173`) |
| `pnpm run build` | SPA 빌드(`dist/`). 함수는 Netlify가 배포 시 `netlify/functions/`에서 번들합니다 |
| `pnpm run preview` | 빌드한 SPA + 함수 코드로 실행 |
| `pnpm run db:migrate` | 인덱스 적용(`worker/db.ts`의 `INDEXES`). 원격 DB는 `--remote` |
| `pnpm run db:migrate:remote` | `.env`의 원격 DB에 인덱스 적용 — **운영 변경** |
| `pnpm run db:seed` | 시드 (멱등). 원격 DB는 `--remote` |
| `pnpm run db:reset` | 앱 컬렉션 삭제 → 인덱스 → 시드. **localhost DB 전용** |
| `pnpm run cron <health\|daily\|drift>` | `.env`의 DB로 예약 작업 1회 실행. 원격 DB는 뒤에 `--remote` |
| `pnpm run typecheck` | app / worker / node tsconfig 각각 `tsc --noEmit` |
| `pnpm test` | Vitest (Node, 인메모리 MongoDB 복제 세트, 외부 API는 fetch mock). `.env`의 DB는 쓰지 않습니다. 첫 실행 때 mongod를 내려받습니다 |

`db:migrate`, `db:seed`, `cron`은 localhost가 아닌 DB면 `--remote` 없이는 멈춥니다. `db:reset`은 원격 DB에서 동작하지 않습니다.

### 디렉터리

| 경로 | 역할 |
|---|---|
| `worker/` | API·인증·cron 로직(Hono). 플랫폼 독립. `worker/index.ts`의 `handleRequest`, `handleScheduled`가 진입점 |
| `netlify/functions/api.ts` | `/api/*`, `/auth/*` 함수 |
| `netlify/functions/cron-*.ts` | 예약 함수 3개. 일정은 `worker/cron/index.ts`의 `CRON_SCHEDULES`와 같아야 합니다(테스트가 확인) |
| `worker/runtime.ts` | 비밀이 아닌 설정 기본값(`DEFAULT_VARS`)과 환경 변수 읽기 |
| `public/_headers`, `public/_redirects` | 정적 파일 보안 헤더, SPA 폴백 |

## 배포 절차 (운영)

아래 명령은 운영 환경을 바꿉니다. 순서대로, 각 단계 결과를 확인하며 직접 실행하세요. Netlify CLI(`npm i -g netlify-cli`)가 필요합니다.

1. MongoDB 준비: Atlas 클러스터와 DB 사용자를 만듭니다. Netlify 함수의 나가는 IP는 고정되지 않으므로 Network Access에서 접속을 허용해야 합니다.
2. 인덱스 적용: `pnpm run db:migrate:remote`(2026-11-01 Atlas에 적용 완료. `INDEXES`를 바꾸면 다시 실행). 이름 중복과 복구 잠금을 유일 인덱스가 막습니다.
3. Netlify 사이트 연결: `netlify login` → `netlify init`(저장소 연결). 빌드 설정은 `netlify.toml`에 있습니다.
4. Netlify 환경 변수 입력(Site configuration → Environment variables, 또는 아래 명령. 비밀 값은 Secret으로 표시):
   ```bash
   netlify env:set DB_CONNECTION_STRING "mongodb+srv://..." --secret
   netlify env:set DB_NAME "..."
   netlify env:set IDP_CLIENT_SECRET "..." --secret
   netlify env:set CF_ZONE_ID "..."
   netlify env:set CF_API_TOKEN "..." --secret
   netlify env:set ADMIN_EMAILS "..."
   ```
   - 나머지 값은 `worker/runtime.ts`의 `DEFAULT_VARS`(운영 기본값)를 씁니다. `IDP_ISSUER`, `IDP_CLIENT_ID`, `REQUIRED_SOHAKOE`도 여기 있습니다. 바꿀 값만 환경 변수로 넣으면 됩니다(`REQUIRED_SOHAKOE`는 체크리스트 7번 결과).
   - `APP_ORIGIN`은 `https://domain.b-cube.kr`, `DNS_DRY_RUN`·`DEV_FAKE_LOGIN`·`DEV_AUTH_DEBUG`는 모두 false여야 합니다. 하나라도 true면 모든 요청이 500이 됩니다(안전장치). Netlify 환경 변수의 Functions 범위에 들어가 있어야 합니다.
5. 배포: `git push`(연결된 브랜치) 또는 `netlify deploy --build --prod`
6. 커스텀 도메인: Netlify → Domain management에서 `domain.b-cube.kr` 추가 → Cloudflare DNS에 `domain` CNAME `<site>.netlify.app`(**DNS only**, 프록시 끔)을 만듭니다. 기존 `domain.b-cube.kr` 레코드(예전 Workers 커스텀 도메인)는 먼저 지웁니다. Netlify가 HTTPS 인증서를 발급할 때까지 기다립니다.
7. 배포 후 확인: [docs/01-manual-checklist.md](docs/01-manual-checklist.md) 8번 체크리스트
   - `https://domain.b-cube.kr/api/health` → `{"status":"ok"}`
   - `/auth/dev-login?as=admin`, `/api/dev/config`, `/auth/debug`가 404
   - Netlify → Logs → Functions에 `cron-health`, `cron-daily`, `cron-drift`가 Scheduled로 표시

### 스키마 변경

컬렉션과 인덱스는 `worker/db.ts`에 있습니다. 인덱스는 `INDEXES`에 추가하고 `pnpm run db:migrate`로 적용합니다(운영은 배포 전에 `db:migrate:remote`). 필드를 바꿀 때는 이미 있는 문서를 함께 고려하세요. 삭제처럼 되돌리기 어려운 변경은 백업(`mongodump`) 후 진행합니다.

### Cloudflare D1 데이터

D1에서 MongoDB로 옮기는 도구는 없습니다. D1에 운영 데이터가 있다면 Workers를 끄기 전에 별도로 옮겨야 합니다. 값 형식이 다른 필드가 있습니다: 감사 로그 `detail`, 드리프트 결과 `items`·`repaired`, `dns_ops.cf_ids`, `users.sohakoe_memberships`는 JSON 문자열이 아니라 문서·배열입니다.

## 운영 가이드

### Cron

Netlify 예약 함수입니다. 예약 함수는 실행 시간이 30초로 제한됩니다.

| cron (UTC) | KST | 작업 |
|---|---|---|
| `17 * * * *` | 매시 17분 | 헬스체크: 24시간 넘게 검사하지 않은 active lease 최대 10개. 하루(KST) 1회 실패 누적, 7일 연속 실패면 일시 중지. 이어서 10분 넘게 남은 DNS 작업 기록(`dns_ops`)을 DB 기준으로 복구 |
| `0 18 * * *` | 매일 03:00 | 만료 처리(만료된 active, 일시 중지 30일 경과), 만료 세션 삭제 |
| `30 18 * * 0` | 월요일 03:30 | 드리프트 점검. "DB에만 있음"·"내용 다름"·종료된 lease의 레코드는 DB 값으로 자동 복구. **"Cloudflare에만 있음"은 자동 삭제하지 않음**. 결과는 관리 → 드리프트 탭 |

### 자주 하는 일

- **피싱·남용 신고**: 관리 → 전체 임대에서 강제 회수(사유 필수), 필요하면 사용자 탭에서 차단. 차단하면 세션이 모두 삭제되고 사용 중·일시 중지 lease가 일괄 회수됩니다. 회수한 이름은 30일간 누구도 신청할 수 없습니다.
- **대시보드 직접 수정 금지 (운영 규칙)**: comment가 `bcd:lease=`로 시작하는 레코드는 Cloudflare 대시보드에서 수정·삭제하지 않습니다. 앱의 DB 값이 기준이라 직접 고친 값은 다음 복구(상세 화면을 연 뒤 1시간 이내, 또는 주간 점검)에서 되돌아갑니다. 바꿀 일이 있으면 앱에서 소유자가 편집하거나 관리자가 회수합니다. 이 앱의 레코드가 아닌 것(comment 없음)은 대시보드에서 관리해도 됩니다.
- **드리프트 정리**: 드리프트 탭에는 자동 복구 후에도 남은 항목만 나옵니다.
  - "Cloudflare에만 있음": 이 앱의 comment가 붙었지만 DB에 근거가 없는 레코드. 앱이 기록하기 전에 함수가 끊겼거나 누군가 comment를 붙여 만든 레코드입니다. 대시보드에서 확인하고 직접 지우세요.
  - "DB에만 있음"·"내용 다름"이 남아 있으면 자동 복구가 실패한 것입니다. "끝나지 않은 DNS 작업" 표의 마지막 오류와 `[repair]` 로그를 확인하세요. 같은 이름에 다른 CNAME이 있어 다시 만들지 못하는 경우가 대표적입니다.
- **끝나지 않은 DNS 작업**: 드리프트 탭 아래 표에 나옵니다. 매시 자동 복구하며, 5번 실패하면 cron은 더 시도하지 않습니다. 원인을 고친 뒤 표 위의 **지금 복구** 버튼을 누르면 실패 횟수와 상관없이 다시 시도합니다.
  - cron과 겹치지 않도록 복구(cron 또는 수동)가 실행된 뒤 3분 동안은 버튼이 막힙니다. 매시 17분 직후가 여기에 해당합니다.
  - 시작한 지 10분이 안 된 작업은 진행 중일 수 있어 수동 복구도 건너뜁니다.
- **예약어 추가**: 코드 수정 없이 Netlify 환경 변수 `EXTRA_RESERVED_NAMES`(쉼표 구분)에 넣고 다시 배포합니다. 금칙어는 `worker/data/banned-words.ts`를 고칩니다.
- **관리자 변경**: Netlify 환경 변수 `ADMIN_EMAILS` 수정 후 다시 배포. 관리자 이메일은 소학회 검사만 면제받습니다(`@ajou.ac.kr`과 `email_verified`는 필요).
- **회원 탈퇴·정보 삭제**: 회원은 상단 메뉴의 "회원 탈퇴"로, 관리자는 사용자 탭의 "회원 정보 삭제"(사유 필수)로 처리합니다. 남은 서브도메인을 끝내고(탈퇴는 반납, 삭제는 회수) 사용자와 세션을 지웁니다. **lease(소유자 이메일), DNS 레코드 내용, 감사 로그(이메일, IP)는 그대로 남습니다.** 같은 계정으로 다시 로그인해도 예전 서브도메인은 보이지 않고(`owner_deleted_at`), 관리 화면에서만 보입니다. 차단된 사용자는 지우면 다시 가입할 수 있으므로 먼저 차단을 해제해야 합니다. Cloudflare 삭제가 실패하면 아무 회원 정보도 지우지 않고 502가 나며, 다시 시도하면 이어서 처리합니다.
- **API 토큰 교체**: 만료 전에 새 토큰을 발급하고 `netlify env:set CF_API_TOKEN "..." --secret` 후 다시 배포.

### 장애 시

- 모든 요청이 500 `config_error`: 설정 오류입니다. Netlify → Logs → Functions(`api`)에서 `[config]` 로그를 확인하세요. 운영에서 개발용 플래그가 켜진 경우가 대표적입니다.
- lease 작업이 502 `dns_error`: Cloudflare API 실패입니다. 상세 원인은 `[dns]` 로그에만 남습니다. 토큰 권한(Zone DNS Edit, Zone Read)과 만료를 확인하세요.
