# 진척 보고 — B-CUBE Domain Console

> 기준 문서: [SPEC.md](SPEC.md)
> 기준 시점: 2026-10-27, 커밋 `b7239fe` (M2~M8 README 변경을 작업 단위 커밋 11개로 나눠 커밋함. push 전)
> 작업 단위(WBS)는 SPEC §13 마일스톤을 1단계로, 각 절의 구현 항목을 2단계로 나눈다.

상태 표기: `완료` · `진행` (일부 구현 또는 골격만 있음) · `미착수` · `확인 필요` (구현은 있으나 완료 기준 확인 기록 없음)

## 1. 요약

| # | 마일스톤 | 작업 수 | 완료 | 진행 | 상태 |
|---|---|---:|---:|---:|---|
| M1 | 프로젝트 골격, 가짜 로그인, 시드 | 15 | 14 | 0 | 확인 필요 (1건) |
| M2 | OAuth, CSRF, 보안 헤더, 개발 기능 차단 | 12 | 12 | 0 | 완료 (실계정 로그인 확인 남음) |
| M3 | 검증 규칙(`shared/rules.ts`) + 단위 테스트 | 10 | 10 | 0 | 완료 |
| M4 | DNS 서비스 + lease API + 감사 로그 | 14 | 14 | 0 | 완료 |
| M5 | 사용자 UI | 13 | 11 | 0 | 확인 필요 (2건, 화면 확인) |
| M6 | 관리자 API + UI | 13 | 12 | 0 | 확인 필요 (1건, 화면 확인) |
| M7 | Cron 3종 | 9 | 8 | 0 | 확인 필요 (1건, 벤더 시그니처) |
| M8 | README, 배포 | 8 | 3 | 1 | 배포 진행 중 (cron 등록 실패 수정, 재배포 필요) |
| | **합계** | **94** | **84** | **1** | **약 89%** |

현재 위치: SPEC의 코드 작업은 모두 구현했다(테스트 7개 파일 284건 통과, 2026-10-28 드리프트 자동 복구 추가). 남은 것은 화면 확인(1.15, 5.12, 5.13, 6.13), 벤더 시그니처 실측(7.4), 운영 배포(8.3, 8.5~8.8, 사용자 확인 필요)다. 2026-10-28 첫 배포에서 cron 등록이 실패해 요일 표기를 고쳤다(8.7). 구현 제한점은 [LIMITATIONS.md](LIMITATIONS.md)에 정리했다.

진행 순서 변경 (2026-10-27):
1. 도메인 화면을 먼저 확인하기 위해 M2의 OAuth(2.1, 2.2), `/auth/debug`(2.8), M2 테스트(2.10~2.12)를 보류하고 M3 → M4 → M5 순서로 진행한다. 가짜 로그인과 `DNS_DRY_RUN=true`만으로 개발할 수 있어 OAuth가 없어도 막히지 않는다. 보류한 M2 작업은 M5 이후에 진행한다.
   - 2026-10-27: 실제 Google 로그인 시험을 위해 사용자 요청으로 보류한 M2를 먼저 완료했다.
2. 사용자 요청으로 M6(관리자)을 M4보다 먼저 구현했다. M6에 필요한 M4의 Cloudflare DNS 서비스(4.1~4.4)만 먼저 만들었다.

## 2. WBS

### M1. 프로젝트 골격

완료 기준: OAuth 클라이언트와 Cloudflare 토큰 없이 §4.4 절차만으로 `npm run dev` → 페르소나 로그인 → Carbon 셸, `/api/health`, `/api/me` 확인. `npm run preview`도 같은 방식으로 동작.

| ID | 작업 | SPEC | 상태 | 산출물 / 비고 |
|---|---|---|---|---|
| 1.1 | Vite + `@cloudflare/vite-plugin` + React 프로젝트 설정, tsconfig 분리 | §2, §3 | 완료 | `vite.config.ts`, `tsconfig.*.json` |
| 1.2 | `wrangler.jsonc` (assets, routes, D1, crons, vars) | §4 | 완료 | `database_id`는 자리표시자. 실제 값은 M8에서 기입 |
| 1.3 | `.dev.vars.example`, `.gitignore` | §0-3, §4.4 | 완료 | `.dev.vars`는 git 제외 확인 |
| 1.4 | D1 마이그레이션 `0001_init.sql` | §5 | 완료 | SPEC 외 `reconcile_runs` 테이블 추가 (드리프트 결과 저장용) |
| 1.5 | `env.ts` 설정 파싱, 개발 모드 완화, 운영 안전장치(500) | §4 | 완료 | `worker/env.ts`, `worker/index.ts` |
| 1.6 | npm 스크립트 고정 | §4.1 | 완료 | `typecheck`는 app/worker/node 3개 tsconfig로 분리 실행 |
| 1.7 | 세션 생성·삭제, 쿠키 이름 분기(`__Host-bcd_session` / `bcd_session`) | §6.2 | 완료 | `worker/auth/session.ts` |
| 1.8 | `requireUser` / `requireAdmin` 미들웨어 | §6.5 | 완료 | `worker/middleware/auth.ts` |
| 1.9 | 개발 전용 가짜 로그인 `/auth/dev-login`, `/api/dev/config` | §4.2 | 완료 | 조건 불충족 시 라우트 미등록 |
| 1.10 | `/api/health`, `/api/me` | §9 | 완료 | `/api/me`는 `csrfToken`, `limits` 포함 |
| 1.11 | Carbon UI Shell (Header, 내비게이션, 로그아웃, g10/g100 테마, Plex Sans KR) | §11 | 완료 | `src/components/AppHeader.tsx`, `src/App.tsx` |
| 1.12 | 로그인 화면 + 개발 모드 페르소나 버튼 | §4.2, §11 | 완료 | `src/pages/Login.tsx` |
| 1.13 | DEV / DRY-RUN 배지 | §4.2 | 완료 | |
| 1.14 | 시드 스크립트, `db:reset` 원클릭 초기화 | §4.3 | 완료 | `scripts/seed.ts`, `scripts/reset-local-db.ts`. `--remote` 거부 |
| 1.15 | 완료 기준 확인 (`dev`, `preview`) | §13 | 확인 필요 | 수동 확인 결과 기록 없음 |

### M2. Google OAuth, CSRF, 보안 헤더

완료 기준: 로컬 로그인 성공/거부 테스트 통과, 개발 기능 차단 테스트 통과.

| ID | 작업 | SPEC | 상태 | 산출물 / 비고 |
|---|---|---|---|---|
| 2.1 | `GET /auth/login`: state, nonce, PKCE 생성, `__Host-bcd_oauth` 쿠키, Google 리다이렉트 | §6.1 | 완료 | `worker/routes/auth.ts`, `worker/auth/google.ts`. 쿠키 값은 `state.nonce.verifier`(서명 없음, `__Host-` 접두사로 cookie tossing 차단). 이전 stub이 로컬 로그인 실패(`oauth_failed`) 원인이었다 |
| 2.2 | `GET /auth/callback`: 코드 교환, `jose` + JWKS로 id_token 검증 (iss, aud, exp, nonce) | §6.1 | 완료 | OAuth 쿠키는 1회용(콜백에서 삭제). state는 상수 시간 비교. `email_verified`는 boolean `true`만 인정. 사용자가 취소하면 `oauth_cancelled`, 그 외 실패는 `oauth_failed`(상세는 서버 로그) |
| 2.3 | 로그인 허용 규칙 (도메인, `email_verified`, hd, 관리자 예외, 차단) | §6.1 | 완료 | `evaluateLogin()` 순수 함수 |
| 2.4 | 가짜 로그인과 실제 로그인의 세션 생성 함수 공유 | §4.2 | 완료 | `completeLogin()` |
| 2.5 | `POST /auth/logout` (CSRF 적용, 감사 로그) | §6.2, §9 | 완료 | |
| 2.6 | CSRF 미들웨어 (Origin 정확 일치 + 토큰 상수 시간 비교) | §6.3 | 완료 | 프론트 `api/client.ts`가 토큰 자동 첨부 |
| 2.7 | 보안 헤더 (Worker 응답 + 정적 자산 `_headers`) | §6.4 | 완료 | |
| 2.8 | `/auth/debug` (개발 전용, 마지막 ID 토큰 클레임 표시) | §6.1 | 완료 | `worker/routes/dev.ts`. 클레임은 isolate 메모리에만 두므로 dev 서버를 재시작하면 사라진다. 거부된 로그인도 기록한다 |
| 2.9 | Vitest + Workers 런타임 테스트 환경 구성 | §2, §12 | 완료 | `vitest.config.ts`로 분리해 `vite.config.ts`의 `cloudflare()` 플러그인 충돌 해결. 설치된 패키지는 `@cloudflare/vitest-pool-workers`의 후속인 `@cloudflare/vitest-plugin`(`cloudflareTest`). D1 마이그레이션은 `test/apply-migrations.ts`가 적용 |
| 2.10 | 테스트: 로그인 허용/거부 | §12 | 완료 | `test/auth.test.ts`. Google token endpoint와 JWKS는 `fetch` mock + 테스트 RSA 키. 도메인, `email_verified`, hd, 관리자 예외, 차단, state/nonce/aud/iss/exp/서명 오류 |
| 2.11 | 테스트: CSRF (Origin 누락, 다른 서브도메인, 토큰 불일치 → 403) | §12 | 완료 | `/auth/logout` 대상. 관리자 API는 `test/admin.test.ts`에서 검증 |
| 2.12 | 테스트: 개발 기능 차단 (운영 주소에서 404/500, `dev-login?as=banned` 거부 흐름) | §12 | 완료 | env를 바꿔 Worker를 직접 호출. 플래그 3종 각각 500, 실제 OAuth 거부와 같은 리다이렉트·감사 로그 비교 |

### M3. 검증 규칙

완료 기준: 규칙 테스트 전부 통과.

| ID | 작업 | SPEC | 상태 | 비고 |
|---|---|---|---|---|
| 3.1 | 이름 정규식, `--`·숫자만·`_` 시작 금지 | §7.1 | 완료 | `checkNameFormat()`, `checkName()` |
| 3.2 | 예약어 목록 + `EXTRA_RESERVED_NAMES` | §7.1 | 완료 | `worker/data/reserved-names.ts`. 목록은 호출하는 쪽에서 넘긴다 |
| 3.3 | 금칙어 부분 문자열 검사 | §7.1 | 완료 | `worker/data/banned-words.ts` (SPEC 예시 + 사칭·욕설 일부) |
| 3.4 | target_kind별 레코드 구성 규칙, CNAME 단독 규칙 | §7.2 | 완료 | `validateRecordSet()`: 정규화된 레코드 또는 입력 순번별 오류 반환 |
| 3.5 | A/AAAA 공인 IP 검사 (사설·예약 대역 거부) | §7.2 | 완료 | IPv4/IPv6 파서와 CIDR 비교 직접 구현 |
| 3.6 | CNAME 값 검증 (FQDN, IP 금지, 존 하위 금지, 끝 점 제거) | §7.2 | 완료 | `checkCnameTarget()` |
| 3.7 | Vercel 검증 TXT 형식 (`vc-domain-verify=<fqdn>,`) | §7.2 | 완료 | 3절 확인 결과 참고 |
| 3.8 | TXT 개수(5)·길이(512)·ASCII, proxied 강제 규칙, TTL 1 | §7.2 | 완료 | proxied는 A/AAAA/CNAME이면 연결 대상과 무관하게 true, TXT는 false로 강제 (2026-10-28 변경: 이전에는 ip 타입 A/AAAA만 사용자 선택). 사용자 화면의 프록시 토글은 제거 |
| 3.9 | lease 입력 zod 스키마 (`shared/schemas.ts`) | §9, §11 | 완료 | `createLeaseSchema`, `replaceRecordsSchema`, `nameAvailabilitySchema`. 형태만 검사하고 규칙은 `rules.ts`가 검사 |
| 3.10 | 단위 테스트 (경계값 포함) | §12 | 완료 | `test/rules.test.ts` 169건 통과. 이름 보류 규칙(`checkNameHold()`)도 순수 함수로 분리해 함께 검증 |

### M4. Cloudflare DNS 서비스 + lease API

완료 기준: 통합 테스트 통과.

| ID | 작업 | SPEC | 상태 | 비고 |
|---|---|---|---|---|
| 4.1 | `cloudflare-dns.ts`: `listByName`, `create`, `update`, `remove`, `listManaged` | §8 | 완료 | 목록은 페이지 순회. `remove`는 이미 없는 레코드(404)를 성공으로 처리. `test/cloudflare-dns.test.ts`에서 가짜 fetch로 요청 형식 검증 |
| 4.2 | dry-run 모드 (`dry_<uuid>`, 로그만) | §8 | 완료 | |
| 4.3 | 레코드 comment `bcd:lease=<id>` | §8 | 완료 | comment 길이 46자(uuid 기준). 무료 플랜 제한은 미확인 |
| 4.4 | 오류 메시지 일반화, 상세는 서버 로그 | §8 | 완료 | `DnsError`. 관리자 API는 502 `dns_error`로 응답 |
| 4.5 | 레코드 교체 순서 (생성 → DB → 삭제), 롤백, D1 batch | §8 | 완료 | `applyRecordSet()`: 같은 레코드 유지, CNAME은 PATCH(같은 host에 CNAME 2개 불가), 실패 시 롤백. `test/leases.test.ts`에서 가짜 Cloudflare API로 호출 순서·롤백 검증 |
| 4.6 | 감사 로그 서비스 | §5, §9 | 완료 | 사용자 lease 경로(생성·교체·연장·재확인·재활성화·반납)와 cron(헬스 실패·suspend·만료·드리프트) 모두 기록. 교체는 변경 전/후 레코드 |
| 4.7 | `GET /api/names/:name/availability` (형식, 예약, 금칙, taken, held, conflict) | §7.1, §9 | 완료 | `checkAvailability()`. 정적 규칙 → 보류/점유(DB) → Cloudflare `name`·`*.name` 조회 순서. 이름은 소문자로 정규화 |
| 4.8 | `GET /api/leases`, `GET /api/leases/:id` (남의 lease → 404) | §6.5, §9 | 완료 | `worker/routes/leases.ts`. 상세는 최근 감사 로그 100건(작업자 이메일·IP 숨김) |
| 4.9 | `POST /api/leases` (1인당 한도 409) | §9 | 완료 | 형식 오류 400, 이름 점유·보류·충돌 409, 한도 409 `limit_reached`, 레코드 오류 400 `invalid_records` + 항목별 `errors` |
| 4.10 | `PUT /api/leases/:id/records` (active만) | §9 | 완료 | 변경이 없으면 Cloudflare 호출·감사 로그 없이 `changed: false` |
| 4.11 | `POST /api/leases/:id/renew` (연장 기간 조건) | §9 | 완료 | active·suspended에서 만료 `RENEW_WINDOW_DAYS` 이내만 |
| 4.12 | `POST /api/leases/:id/recheck` (suspended 복구) | §9, §10.2 | 완료 | lease당 1분 1회(429). suspended는 DoH/TCP만 확인(`target` 모드) 후 레코드 재생성 → active, `lease.reactivate` 기록. 실패는 횟수에 넣지 않음 |
| 4.13 | `DELETE /api/leases/:id` (반납, `released`) | §9 | 완료 | DB records는 이력으로 유지(`cf_record_id = NULL`) |
| 4.14 | 통합 테스트 (한도, 404, Cloudflare 호출 순서·롤백, 감사 로그) | §12 | 완료 | `test/leases.test.ts` 26건 |

### M5. 사용자 UI

완료 기준: 가짜 로그인 + 시드 + dry-run 상태에서 페르소나별 화면 확인, 확인 화면 목록 보고.

| ID | 작업 | SPEC | 상태 | 비고 |
|---|---|---|---|---|
| 5.1 | API 클라이언트 (CSRF 자동 첨부, 오류 처리) | §6.3, §11 | 완료 | `src/api/leases.ts`. `ApiError`에 레코드 항목별 오류 포함 |
| 5.2 | 내 서브도메인 `DataTable` (상태 Tag, 만료일, 헬스, OverflowMenu) | §11 | 완료 | `src/pages/MyLeases.tsx`. 좁은 화면은 표만 가로 스크롤 |
| 5.3 | 만료 임박 / suspended `ActionableNotification` | §10.1, §11 | 완료 | 만료 임박은 연장, suspended는 재확인 액션 |
| 5.4 | "새 서브도메인" 버튼, 한도 도달 시 비활성 + 툴팁 | §11 | 완료 | 한도 도달 시 비활성 + `Tooltip`, 모바일용 안내 문구도 함께 표시 |
| 5.5 | 생성 4단계 (이름 디바운스 조회, RadioTile 3종, 대상별 폼, 미리보기) | §11 | 완료 | `src/pages/NewLease.tsx`. 형식 오류는 즉시, 서버 가용성은 300ms 디바운스(이전 요청 취소). 서버 검증 실패 시 해당 단계로 돌아감 |
| 5.6 | 생성 후 대상별 연결 가이드 | §11 | 완료 | `src/components/ConnectionGuide.tsx` |
| 5.7 | 상세 화면 (레코드, 헬스 상태, 감사 로그 타임라인) | §11 | 완료 | `src/pages/LeaseDetail.tsx`. 타임라인의 detail JSON 펼쳐보기 |
| 5.8 | 편집 폼 (생성 3단계 재사용) | §11 | 완료 | `src/components/RecordsEditor.tsx`를 생성·편집에서 공용. 클라이언트에서 `validateRecordSet()`으로 먼저 검증 |
| 5.9 | 연장 / 재확인 동작 | §11 | 완료 | 목록 OverflowMenu와 상세 버튼 |
| 5.10 | 반납 `Modal danger` (이름 입력 확인) | §11 | 완료 | `src/components/ReleaseModal.tsx` |
| 5.11 | `ToastNotification`, `DataTableSkeleton` / `InlineLoading` | §11 | 완료 |  |
| 5.12 | 모바일 폭(375px) 레이아웃 | §11 | 확인 필요 | 레이아웃 CSS 작성(표 가로 스크롤, 입력 행 줄바꿈). 375px 실제 화면 확인 기록 없음 |
| 5.13 | 페르소나별 화면 확인 (`user`, `full`, `new`, `banned`) | §13 | 확인 필요 | 격리된 dev 서버(dry-run + 가짜 로그인)에서 API 스모크와 모듈 변환까지 확인. 브라우저 화면 확인 기록 없음. 시드의 `member1`은 이미 한도 도달이라 생성 흐름은 `newbie`로 확인해야 함 |

### M6. 관리자 API + UI

완료 기준: 통합 테스트 통과 + `admin` 페르소나로 4개 탭 화면 확인.

| ID | 작업 | SPEC | 상태 | 비고 |
|---|---|---|---|---|
| 6.1 | `GET /api/admin/leases` (상태 필터, 검색, 페이지) | §9 | 완료 | 페이지당 20개, 레코드 포함. 검색어의 `%`, `_`는 문자 그대로 취급 |
| 6.2 | `POST /api/admin/leases/:id/revoke` (사유 필수) | §9 | 완료 | `worker/services/leases.ts`의 `revokeLease()`. active/suspended만 가능(그 외 409) |
| 6.3 | `GET /api/admin/users` (보유 수, 차단 필터) | §9 | 완료 | 사용 중(active+suspended)/전체 보유 수 |
| 6.4 | `POST /api/admin/users/:email/ban` (세션 삭제, active lease 일괄 revoke) | §9 | 완료 | suspended도 회수, 자기 자신 차단 금지 (SPEC §9 반영) |
| 6.5 | `POST /api/admin/users/:email/unban` | §9 | 완료 | 사유 선택. revoke된 lease는 복구하지 않음 |
| 6.6 | `GET /api/admin/audit-logs` (필터, 페이지) | §9 | 완료 | 페이지당 25개. 작업자는 부분 일치, lease는 이름 또는 id, 기간은 ms |
| 6.7 | `GET /api/admin/drift` | §9 | 완료 | 최근 `reconcile_runs` 1건 |
| 6.8 | 관리 탭: 전체 임대 (강제 회수 Modal) | §11 | 완료 | `src/pages/admin/LeasesTab.tsx`. Cloudflare에 없는 레코드는 취소선 |
| 6.9 | 관리 탭: 사용자 (차단/해제) | §11 | 완료 | `UsersTab.tsx` |
| 6.10 | 관리 탭: 감사 로그 (필터, 페이지네이션, detail 펼침) | §11 | 완료 | `AuditLogsTab.tsx`. 기간 입력은 `TextInput type="date"` |
| 6.11 | 관리 탭: 드리프트 | §11 | 완료 | `DriftTab.tsx` |
| 6.12 | 통합 테스트 (일반 사용자 403, 차단 시 세션 삭제와 일괄 revoke) | §12 | 완료 | `test/admin.test.ts` 15건. CSRF, 감사 로그, 필터·페이지네이션 포함 |
| 6.13 | `admin` 페르소나 화면 확인 | §13 | 확인 필요 | dev 서버에서 시드 데이터로 API 응답(회수 이력, 차단 사용자, 감사 로그, 드리프트 2건)은 확인. 브라우저 화면 확인 기록 없음 |

### M7. Cron 3종

완료 기준: 로컬 `scheduled` 트리거 테스트 통과.

| ID | 작업 | SPEC | 상태 | 비고 |
|---|---|---|---|---|
| 7.1 | `scheduled` 핸들러의 `controller.cron` 분기 | §10 | 완료 | `worker/cron/index.ts`. 로컬 수동 실행: `/cdn-cgi/handler/scheduled?cron=...` (README) |
| 7.2 | 만료 처리 (`0 18 * * *`) | §10.1 | 완료 | `worker/cron/expiry.ts`. 1회 최대 50개. 만료 세션 삭제도 같은 cron |
| 7.3 | 헬스 판정: CNAME 계열 (DoH 조회 + HTTP GET) | §10.2 | 완료 | `worker/services/health.ts`. DoH A/AAAA 병렬 조회, HTTP 10초 타임아웃 |
| 7.4 | 벤더 "주인 없음" 시그니처 테이블 (Vercel, Netlify, GitHub Pages) | §10.2 | 확인 필요 | `VENDOR_SIGNATURES` 테이블(Vercel, Netlify, GitHub Pages) 구현. 실제 응답으로 확인하지 않음(모두 `verified: false`) |
| 7.5 | 헬스 판정: IP 계열 (`cloudflare:sockets` TCP 443/80) | §10.2 | 완료 | 443 → 80, 5초 타임아웃. 실제 IPv6 연결은 미확인 |
| 7.6 | 헬스 결과 처리 (실패 누적, 유예 기간, 1회 실행 10개, suspend) | §10.2 | 완료 | `worker/cron/health.ts`. 실패는 KST 하루 1회만 누적·기록 |
| 7.7 | suspended가 `NAME_HOLD_DAYS` 지나면 expired 전환 | §10.2 | 완료 | `migrations/0002_suspended_at.sql`로 suspended 시각 저장, 만료 cron에서 처리 |
| 7.8 | 드리프트 점검 (`30 18 * * SUN`), 자동 삭제 없음 | §10.3 | 완료 | `worker/cron/reconcile.ts`. TXT 따옴표·AAAA 축약·CNAME 대소문자 정규화 후 비교. 조회 실패도 `ok=0`으로 기록 |
| 7.9 | 테스트 (실패 누적 → suspend → recheck 복구, 만료, 이름 보류) | §12 | 완료 | `test/cron.test.ts` 17건 (실패 누적 → suspend → recheck 복구, 유예 기간, 배치 10개, 만료·이름 보류, 드리프트) |

### M8. README와 배포

완료 기준: 사용자 확인 후 remote 마이그레이션과 deploy.

| ID | 작업 | SPEC | 상태 | 비고 |
|---|---|---|---|---|
| 8.1 | README (로컬 실행 §4.4, 배포 절차, 운영 가이드) | §4.4, §13 | 완료 | `README.md` (로컬 실행, cron 수동 실행, 배포 절차, 운영 가이드). 제한점은 `docs/LIMITATIONS.md` |
| 8.2 | 운영 D1 생성, `database_id` 기입 | §4 | 완료 | 사용자 작업. `wrangler.jsonc`에 실제 id 기입 확인 (2026-10-28) |
| 8.3 | 운영 vars 기입 (`CF_ZONE_ID`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`) | §4 | 미착수 | 사용자 제공 값 |
| 8.4 | Google OAuth 클라이언트 리디렉트 URI 등록 | §6.1 | 완료 | 사용자 작업. 체크리스트 4번대로 설정했다고 보고받음 (2026-10-27) |
| 8.5 | `wrangler secret put` (`GOOGLE_CLIENT_SECRET`, `CF_API_TOKEN`) | §4 | 미착수 | 실행 전 사용자 확인 필수 |
| 8.6 | `wrangler d1 migrations apply --remote` | §0-2 | 미착수 | 실행 전 사용자 확인 필수. 적용 대상 0001~0003. 2026-10-28 운영 로그인 콜백이 `completeLogin`의 첫 D1 쿼리(`users` 조회)에서 500. 원격 마이그레이션 미적용으로 추정(권한상 운영 D1 미조회) |
| 8.7 | `npm run deploy`, 커스텀 도메인 연결 | §0-2 | 진행 중 | 사용자 실행 (2026-10-28). 업로드와 `domain.b-cube.kr` 연결은 성공, cron 등록이 `invalid cron string: 30 18 * * 0`으로 실패. 요일을 `SUN`으로 고침. 다시 배포해야 cron 3개가 등록됨 |
| 8.8 | 운영 스모크 확인 (로그인, `/api/health`, 보안 헤더) | §13 | 미착수 | |

## 3. 구현 중 확인·보고할 사항

| 항목 | 관련 작업 | 상태 |
|---|---|---|
| Vercel 검증 TXT 형식이 SPEC과 같은지 공식 문서로 확인 | 3.7 | 확인 (2026-10-27). 위치 `_vercel.<apex>`와 여러 값 공존은 문서와 일치. 값 형식은 문서에 명시되지 않아 SPEC 형식(`vc-domain-verify=<fqdn>,`) 유지 |
| Vercel CNAME 값 형식 | 3.7 | 확인 (2026-10-27). 문서상 프로젝트별 값은 `d1d4fc829fe7bc7c.vercel-dns-017.com` 형태. SPEC의 `*.vercel-dns.com`만으로는 막히므로 `*.vercel-dns-<숫자>.com`도 허용 |
| Cloudflare 무료 플랜 레코드 comment 길이 제한 | 4.3 | 공식 문서 미확인. 현재 comment 46자로 알려진 제한(100자) 안 |
| 벤더별 "주인 없음" 응답 시그니처 | 7.4 | 미확인. 추정 시그니처로 구현(LIMITATIONS 1.3) |
| CSP를 셀프 호스팅 기준에서 조정했는지 | 2.7 | 조정 (2026-10-28). 폰트를 jsDelivr CDN으로 옮기며 `style-src`, `font-src`에 `https://cdn.jsdelivr.net` 추가 |
| 폰트 CDN 선택 (한국 기준 최속) | 1.x | 완료 (2026-10-28). 셀프 호스팅(`@fontsource` 번들)에서 jsDelivr `@fontsource/ibm-plex-sans-kr@5.3.0`로 전환, SRI(sha384) 적용, 패키지 제거. 한국(Cloudflare ICN) 측정: jsDelivr woff2 약 35ms, Google Fonts(`fonts.gstatic.com`) 약 170ms, cdnfonts CSS 약 210ms. 측정은 한 회선 기준 |
| 코드 표시 폰트 D2Coding | 5.x | 완료 (2026-10-28). jsDelivr `d2coding@1.3.2` subset CSS(SRI 적용), `styles.scss`의 `$font-mono`로 `.mono`, `.json`, `.json-detail`에 적용. Carbon 내장 컴포넌트의 코드 글꼴(IBM Plex Mono 지정)은 바꾸지 않음 |
| 드리프트 감소와 자동 복구 | 7.8 | 완료 (2026-10-28). ① DNS 작업 기록 `dns_ops`(intent log, `migrations/0003_dns_ops.sql`) ② 매시·주간 자동 복구(`worker/services/repair.ts`), "Cloudflare에만 있음"은 보고만 ③ 상세 화면 Cloudflare 실제 상태(`dnsState`) ④ 대시보드 직접 수정 금지 운영 규칙(`DEV.md`). SPEC §0-4, §5, §8, §9, §10.2, §10.3 변경. 테스트 `test/repair.test.ts` 9건 추가, 주간 점검 테스트 갱신 |
| DNS 작업 기록 수동 복구 | 7.8 | 완료 (2026-10-28). 드리프트 탭 "지금 복구" 버튼, `POST /api/admin/dns-ops/recover`(시도 상한 무시, 감사 로그 `admin.dns_recover`). 잠금 `job_locks`(`migrations/0004_job_locks.sql`)로 cron·수동 실행 뒤 3분간 다른 실행 거부. 복구 예약(`repair`)은 10분 대기 없이 처리. 테스트 5건 추가(284건 통과) |
| 운영 500 로그에 오류 메시지가 빠짐 | 2.x | 해결 (2026-10-28). `app.onError`가 `err.message`와 `cause`를 따로 남김 (`worker/app.ts`) |
| 빌드 경고 "Some chunks are larger than 500 kB" (JS 단일 청크 650kB) | 5.x | 해결 (2026-10-28). 새 서브도메인·상세·관리 화면을 `React.lazy`로 분리, react·carbon 라이브러리 청크 분리(`vite.config.ts`). 최대 청크 258kB. CSS(1.4MB, gzip 217kB)는 Carbon 전체 스타일이라 그대로 |
| 테스트가 `wrangler.jsonc`의 운영 `REQUIRE_HD=true`에 영향받음 | 2.x | 해결 (2026-10-28). `vitest.config.ts` 바인딩에 `REQUIRE_HD`, `EXTRA_RESERVED_NAMES` 고정 |
| 모든 A/AAAA/CNAME을 프록시로 등록한 뒤 실제 동작 | 3.8 | 미확인 (2026-10-28 변경). Vercel이 프록시 뒤에서 인증서를 발급하는지, 헬스체크(`https://<fqdn>/` 요청과 벤더 시그니처)가 프록시를 거쳐도 맞게 판정하는지 배포 후 확인 필요. 변경 전에 만든 레코드는 proxied=false 그대로이고, 소유자가 레코드를 편집하면 그때 프록시로 바뀐다 |
| 실제 Google 계정 로그인과 `hd` 클레임 (체크리스트 7번) | 2.1, 2.2, 2.8 | 미확인. 사용자가 브라우저에서 직접 로그인해야 한다. 로컬 `/auth/login`이 Google로 올바른 파라미터(PKCE, `redirect_uri=http://localhost:5173/auth/callback`)와 함께 리다이렉트하는 것까지 확인 (2026-10-27) |

## 4. SPEC과 다른 점

현재 SPEC과 다른 구현은 없다(아래 반영 이력 참고). 마일스톤 진행 순서만 SPEC §13과 다르다(1절 참고).

### SPEC 반영 이력

2026-10-27: 구현 중 생긴 아래 차이를 사용자가 수용해 [SPEC.md](SPEC.md)에 반영했다.

| 내용 | 반영 위치 |
|---|---|
| `reconcile_runs` 테이블 추가 (드리프트 결과 저장) | §5 |
| `typecheck`는 app, worker, node 3개 tsconfig를 각각 검사 | §4.1 |
| Vercel CNAME 값으로 `*.vercel-dns-<숫자>.com`도 허용, 검증 TXT 형식 확인 결과 | §7.2 |
| 레코드 입력 `host`는 FQDN, 대소문자와 끝의 점 정규화 | §7.2 |
| `/api/me` 응답에 `zone` 추가 | §9 |
| 사용자 차단 시 suspended lease도 회수, 자기 자신 차단 금지 | §9 |
| 테스트 설정 분리, `@cloudflare/vitest-plugin`, 바인딩 고정과 마이그레이션 적용 | §12 |
| 2026-10-27: 매일 cron에서 만료 세션 삭제 (세션은 D1 유지, JWT 전환 검토 후 기각) | §10.1 |
| 2026-10-27: `leases.suspended_at` 컬럼 추가 (`migrations/0002_suspended_at.sql`) | §5 |
| 2026-10-27: 레코드 교체 시 같은 레코드 유지, CNAME은 PATCH, 기존 레코드 삭제 실패는 성공 처리 후 드리프트로 감지 | §8 |
| 2026-10-27: 에러 본문의 `errors`, 이름 정규화와 400/409 구분, 502 `dns_error` | §9 |
| 2026-10-27: 연장·재확인·반납 가능 상태, 재확인 1분 제한과 실패 미집계, suspended 재확인 방식, 소유자용 감사 로그 범위 | §9 |
| 2026-10-27: suspended 만료는 매일 만료 cron에서 처리, 실패 집계는 KST 하루 1회 | §10.2 |
| 2026-10-27: dry-run 드리프트 결과 안내 | §10.3 |
| 2026-10-28: 작업 기록 수동 복구 API·버튼, 복구 잠금 3분(`job_locks`), `repair` 예약 즉시 처리 | §5, §8, §9, §10.2, §11 |
| 2026-10-28: DNS 작업 기록(`dns_ops`)과 lease 단위 자동 복구, 드리프트 점검의 안전한 자동 복구("Cloudflare에만 있음" 제외), 상세 화면 `dnsState`, 조작 근거에 `dns_ops.cf_ids` 추가 | §0-4, §5, §8, §9, §10.2, §10.3, §11 |
| 2026-10-30: 인증을 Google OAuth 직접 호출에서 B-CUBE IdP(OIDC)로 일괄 전환. `REQUIRE_HD`, `hd` 검사, 관리자 도메인 면제 제거. `REQUIRED_SOHAKOE` 소학회 회원 검사 추가(이력 존재만 확인, 관리자 면제). `users.google_sub`를 `idp_sub`로 변경하고 `student_id`, `sohakoe_memberships` 추가(`migrations/0005_idp_users.sql`). sub 우선 계정 조회, CSP에서 Google 주소 제거 | §4, §5, §6.1, §6.4, §12 |
| 2026-10-28: 코드 표시 폰트 D2Coding (jsDelivr) | 디자인 |
| 2026-10-28: 폰트를 jsDelivr CDN에서 불러오고 CSP에 `cdn.jsdelivr.net` 추가 | §6.4, 디자인 |
| 2026-10-28: 드리프트 cron 요일을 `0`에서 `SUN`으로 변경 (Cloudflare cron은 요일 `0`을 받지 않음) | §4, §10.3 |
| 2026-10-28: A/AAAA/CNAME 레코드는 연결 대상과 무관하게 Cloudflare 프록시(proxied=true) 강제, TXT는 false. 사용자 화면의 프록시 토글 제거, 연결 가이드와 수동 체크리스트 문구 수정 | §7.2, §11 |

## 4-1. 문서 작업 기록

| 날짜 | 내용 |
|---|---|
| 2026-10-28 | `docs/report_template.md` 양식에 맞춰 프로젝트 기획서 `PROPOSAL.md`를 루트에 작성. 대회명·접수번호·선정기관, 화면 캡처 이미지는 비워 둠(`{{ }}`, `<!-- 캡처 필요 -->`) |
| 2026-10-28 | `PROPOSAL.md`에 소학회 도메인 사용으로 소학회원의 구성원 의식을 높인다는 내용 추가(1.1 수요, 핵심 메시지, 4.1 ①, 4.2 효과 2). 문서의 "동아리" 표기를 "소학회"로 통일 |

## 5. 다음 작업

0. B-CUBE IdP 전환 마무리 (2026-10-30, 코드와 테스트 완료, #15 리뷰·배포 전): 동적 등록 완료(RFC 7591, `client_id` `dyn-f6c226535e6a490f8ff1`을 `IDP_CLIENT_ID`에 반영, 2026-10-30). 남은 일은 등록 토큰 폐기(작업 중 `wrangler.jsonc`에 들어갔다가 제거, 커밋되지 않음), 관리자 승인(`b_cube_status: pending`), `IDP_CLIENT_SECRET` 입력, `/auth/debug`로 실제 소학회 이름 확인, 원격 마이그레이션 직후 배포, 기존 Google 클라이언트 삭제 (사용자)
1. 로컬 D1 재시드: `npm run db:reset` (시드에 `suspended_at` 추가. 0002 마이그레이션은 로컬에 적용 완료. 0005 적용도 이 명령으로 된다)
2. 화면 확인 (사용자): 1.15(`dev`, `preview`), 5.12(375px), 5.13(페르소나별), 6.13(관리 탭 4개)
3. 실제 IdP로 로그인하고 `/auth/debug`에서 소학회 이름 확인 → `REQUIRED_SOHAKOE` 확정 (사용자)
4. 7.4: 벤더별 주인 없음 응답 실측 후 `VENDOR_SIGNATURES` 확정
5. M8 배포(8.3, 8.5~8.8): cron 수정 반영해 `npm run deploy` 다시 실행, Workers 대시보드 Triggers에 cron 3개 확인. 운영에 영향을 주는 명령이므로 사용자 확인 후 실행
