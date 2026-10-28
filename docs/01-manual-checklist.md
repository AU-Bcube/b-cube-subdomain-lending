# b-cube.kr 서브도메인 대여 서비스 — 수동 작업 체크리스트

> 브라우저(일부 터미널)로 **직접** 해야 하는 작업만 모았습니다. 코드 작업은 `SPEC.md`를 Claude Code에 넘기세요.
> 진행 순서: **1, 2, 5**만 마치면 Claude Code 작업(M1)을 시작할 수 있습니다. 로컬 개발은 개발용 가짜 로그인과 `DNS_DRY_RUN`으로 진행하므로 OAuth와 API 토큰이 필요 없습니다.
> **3(API 토큰)과 4(OAuth)**는 M2(실제 Google 로그인) 전까지 끝내면 됩니다. 6~8은 개발·배포 중이나 배포 후에 합니다.

---

## 1. Cloudflare 대시보드 사전 점검

- [ ] `dash.cloudflare.com` → **b-cube.kr** 존 → 우측 하단 **API** 영역에서 다음 값을 복사해 둡니다.
  - **Zone ID** → `CF_ZONE_ID`
  - **Account ID** → `wrangler.jsonc`의 `account_id`
- [ ] **DNS → Records**에서 현재 레코드를 확인합니다.
  - [ ] `domain.b-cube.kr` 레코드가 **없어야** 합니다. 있으면 삭제하세요. Worker 커스텀 도메인이 자동으로 생성합니다.
  - [ ] 이미 쓰고 있는 서브도메인 이름(예: `www`, 메인 사이트, 메일 관련)을 메모해 두세요. 이 이름들은 SPEC의 예약어 목록(`RESERVED_NAMES`)에 추가합니다.
  - [ ] 레코드가 많지 않다면 **Export**로 백업 파일을 받아 둡니다.
- [ ] 존 개요나 DNS 설정 화면에서 **플랜(Free)과 DNS 레코드 개수 한도**를 확인하고 메모합니다.
- [ ] **SSL/TLS → Overview**에서 현재 암호화 모드(Flexible/Full/Full strict)를 메모합니다.
  - 이 콘솔이 만드는 A/AAAA/CNAME 레코드는 모두 프록시(주황 구름)로 등록되므로 이 설정이 동아리원 사이트 전부에 적용됩니다. 현재 사이트에 영향이 없도록 **지금 바꾸지는 마세요.**

## 2. 기존 사이트 쿠키 점검 (쿠키 공유 리스크)

- [ ] Netlify 등에서 운영 중인 `b-cube.kr` / `www.b-cube.kr`에 접속합니다.
- [ ] 개발자도구 → **Application → Cookies**를 엽니다.
- [ ] **Domain 열이 `.b-cube.kr`(점으로 시작)인 쿠키**가 있는지 확인합니다.
  - 있다면, 동아리원 서브도메인이 그 쿠키를 읽거나 덮어쓸 수 있습니다. 해당 사이트 코드에서 쿠키의 `Domain` 속성을 제거해 host-only 쿠키로 바꾸세요.
  - 로그인 기능이 없는 정적 사이트라면 보통 문제가 없습니다.

## 3. Cloudflare API 토큰 발급 (DNS 조작 전용)

- [ ] 우측 상단 프로필 → **My Profile → API Tokens → Create Token → Custom token**을 선택합니다.
- [ ] 다음과 같이 설정합니다.
  - **Token name**: `bcube-domain-console-dns`
  - **Permissions**:
    - `Zone` / `DNS` / `Edit`
    - `Zone` / `Zone` / `Read`
  - **Zone Resources**: `Include` / `Specific zone` / `b-cube.kr` (**All zones 선택 금지**)
  - **Client IP Address Filtering**: 비워 둡니다. Workers의 출구 IP는 고정되지 않기 때문입니다.
  - **TTL**: 만료일을 두려면 1년 정도로 정하고, 캘린더에 갱신 알림을 등록하세요.
- [ ] 생성 후 표시되는 토큰을 **한 번만** 복사해 안전한 곳에 보관합니다 → `CF_API_TOKEN`
- [ ] 같은 페이지의 토큰 **Verify** 안내 명령으로 토큰이 유효한지 확인합니다(선택).

## 4. Google OAuth 클라이언트 생성

> Google Cloud Console의 OAuth 메뉴는 현재 **Google Auth Platform**이라는 이름으로 표시됩니다(이전 이름: OAuth consent screen / Credentials).

- [ ] `console.cloud.google.com` → 새 프로젝트 `bcube-domain`을 생성합니다.
- [ ] **Google Auth Platform** → 시작하기(또는 OAuth 동의 화면)에서 다음을 설정합니다.
  - **App name**: `B-CUBE Domain`
  - **User support email**: 관리자 이메일
  - **Audience**: **External**
    - ajou.ac.kr 조직 소속 프로젝트가 아니므로 Internal은 선택할 수 없습니다. 아주대 계정 제한은 서버에서 검증합니다.
  - **Contact email**: 관리자 이메일
- [ ] **Branding → Authorized domains**에 `b-cube.kr`을 추가합니다.
  - 소유권 확인을 요구하면 Google Search Console에서 DNS TXT 방식으로 확인합니다. TXT 레코드는 Cloudflare DNS에서 직접 추가하세요.
- [ ] **Data access(범위)**: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`만 추가합니다. 민감한 범위는 넣지 마세요.
- [ ] **Audience → Publishing status**를 **In production**으로 게시합니다.
  - Testing 상태로 두면 등록한 테스트 사용자만 로그인할 수 있습니다.
  - 기본 범위만 쓰므로 Google의 앱 심사는 필요 없습니다.
- [ ] **Clients → Create client** → 유형 **Web application**을 선택하고 다음을 입력합니다.
  - **Authorized JavaScript origins**
    - `https://domain.b-cube.kr`
    - `http://localhost:5173`
  - **Authorized redirect URIs**
    - `https://domain.b-cube.kr/auth/callback`
    - `http://localhost:5173/auth/callback`
- [ ] 생성된 값을 복사합니다.
  - **Client ID** → `GOOGLE_CLIENT_ID`
  - **Client secret** → `GOOGLE_CLIENT_SECRET`

## 5. 로컬 개발 환경

- [ ] Node.js **20 이상**이 설치되어 있는지 확인합니다(`node -v`).
- [ ] 프로젝트 폴더에서 `npx wrangler login`을 실행하면 브라우저가 열립니다. Cloudflare 계정으로 승인하세요.
  - 이 로그인은 배포·D1 생성용입니다. DNS 조작용 토큰(3번)과는 **별개**입니다.
- [ ] 관리자 이메일 목록을 정합니다 → `ADMIN_EMAILS=a@ajou.ac.kr,b@ajou.ac.kr`

## 6. 시크릿 입력 (Claude Code가 프로젝트 골격을 만든 뒤)

> 시크릿 값은 Claude Code 대화창에 붙여 넣지 말고 **직접** 입력하세요.

- [ ] 로컬 개발용: `cp .dev.vars.example .dev.vars`로 복사합니다. 기본값만으로 가짜 로그인 + dry-run이 동작합니다. `.gitignore`에 포함되어 있는지 확인하세요.
  - 실제 Google 로그인을 시험할 때만 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`을 채웁니다.
  - `DNS_DRY_RUN=true`는 유지하고, 실제 DNS 변경 테스트는 마지막에만 합니다.
- [ ] 로컬 UI 확인: `npm run db:reset` → `npm run dev` → `http://localhost:5173` 로그인 화면 하단의 페르소나 버튼(일반/한도 도달/신규/관리자/차단)으로 각 화면을 확인합니다.
- [ ] 운영용: 터미널에서 직접 실행합니다.
  ```bash
  npx wrangler secret put GOOGLE_CLIENT_SECRET
  npx wrangler secret put CF_API_TOKEN
  ```
- [ ] `GOOGLE_CLIENT_ID`, `CF_ZONE_ID`, `ADMIN_EMAILS` 등 비밀이 아닌 값은 `wrangler.jsonc`의 `vars`에 들어가는지 확인합니다.

## 7. 아주대 계정 `hd` 클레임 확인 (인증 단계 구현 후)

- [ ] 로컬(`DEV_AUTH_DEBUG=true`)에서 **@ajou.ac.kr 계정**으로 로그인한 뒤 `/auth/debug` 화면에서 ID 토큰 클레임을 확인합니다.
  - `hd: "ajou.ac.kr"`가 **있으면** → `REQUIRE_HD=true` (더 엄격한 검증)
  - **없으면** → `REQUIRE_HD=false` (이메일 도메인 + `email_verified`로 검증)
- [ ] 확인이 끝나면 `DEV_AUTH_DEBUG`를 끕니다. 운영에서는 항상 꺼져 있어야 합니다.

## 8. 배포 후 검증 체크리스트

- [ ] `https://domain.b-cube.kr` 접속 시 정상 HTTPS인지 확인합니다.
- [ ] 로그인 화면에 **DEV 배지와 페르소나 버튼이 없는지**, `https://domain.b-cube.kr/auth/dev-login?as=admin`이 404인지 확인합니다.
- [ ] **@ajou.ac.kr 계정**으로 로그인이 되는지 확인합니다.
- [ ] **개인 gmail 계정**으로는 로그인이 거부되는지 확인합니다. 단, `ADMIN_EMAILS`에 있는 주소는 예외입니다.
- [ ] 개발자도구 → Cookies에서 세션 쿠키를 확인합니다.
  - [ ] 이름이 `__Host-`로 시작하는지
  - [ ] **Domain**이 `domain.b-cube.kr`(점 없음)인지
  - [ ] HttpOnly, Secure가 체크되어 있는지
- [ ] 테스트 서브도메인(예: `test-kang`)을 Vercel 프리셋으로 생성합니다.
  - [ ] Cloudflare DNS 화면에 레코드가 생겼고, Comment에 `bcd:lease=...` 태그가 붙어 있는지 확인합니다.
  - [ ] CNAME 레코드는 프록시가 **켜져(주황 구름)** 있고, TXT 레코드는 DNS only인지 확인합니다.
  - [ ] Vercel 도메인 화면에서 인증서 발급과 "Valid Configuration" 표시를 확인합니다. Vercel은 Cloudflare 프록시 뒤에 두는 구성을 권장하지 않으므로, 실패하면 SSL/TLS 모드(Full strict 권장)를 점검합니다.
- [ ] 예약어(`www`, `admin`)와 사설 IP(`192.168.0.1`) 입력이 거부되는지 확인합니다.
- [ ] 4번째 서브도메인 생성이 차단되는지 확인합니다(1인당 한도 3개).
- [ ] 관리자 계정으로 `/admin`에 들어가 강제 회수, 사용자 차단, 감사 로그를 확인합니다.
- [ ] 일반 계정으로 `/admin`과 `/api/admin/*`에 접근하면 403이 나는지 확인합니다.
- [ ] Workers 대시보드 → 해당 Worker → **Triggers**에 Cron이 등록되어 있는지 확인합니다.
- [ ] 테스트 서브도메인을 삭제한 뒤 Cloudflare DNS에서도 사라졌는지 확인합니다.

## 9. 운영 중 정기 작업

- [ ] 월 1회: `/admin`의 **드리프트** 탭을 확인합니다. 자동 복구 후 남은 항목(주로 "Cloudflare에만 있음")과 "끝나지 않은 DNS 작업"을 정리하세요.
- [ ] 운영 규칙: comment가 `bcd:lease=`인 레코드는 Cloudflare 대시보드에서 직접 고치지 않습니다. 직접 고친 값은 자동 복구로 되돌아갑니다.
- [ ] 학기 초: 졸업·탈퇴 회원의 임대를 회수하고, 관리자 이메일 목록(`ADMIN_EMAILS`)을 갱신합니다.
- [ ] Cloudflare API 토큰 만료 전에 재발급하고 `wrangler secret put CF_API_TOKEN`으로 교체합니다.
- [ ] 피싱이나 남용 신고가 들어오면 → 관리자 강제 회수 + 사용자 차단. 사유는 감사 로그에 기록됩니다.
