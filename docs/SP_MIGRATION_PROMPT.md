# SP 인증을 B-CUBE IdP로 전환하는 Claude Code 프롬프트

## 사용법

1. 전환할 SP 저장소 루트에서 Claude Code를 연다.
2. 아래 **프롬프트** 블록 전체를 복사해 붙여 넣는다.
3. 첫 줄의 값 세 개를 상황에 맞게 고친다. 모르면 그대로 둔다. Claude가 물어본다.
4. Claude는 조사와 계획을 먼저 보여주고, 사용자 데이터나 기존 로그인에 영향을 주는 결정은 물어본 뒤에 진행한다.

준비물:

- SP의 `client_id`와 `client_secret`. 아래 중 하나로 받는다.
  - 관리자에게 요청한다(관리 화면에서 만들어 준다).
  - 관리자에게 등록 토큰(initial access token)을 받아 직접 등록한다. 프롬프트 안의 Claude가 등록 명령을 안내한다.

비밀값(`client_secret`, `registration_access_token`, 등록 토큰)은 프롬프트에 붙여 넣지 않는다. Claude가 비밀값이 들어갈 자리를 알려주면 직접 넣는다.

---

## 프롬프트

````text
ISSUER=https://id.b-cube.kr   SCOPES=openid email profile

이 저장소의 로그인 기능을 B-CUBE IdP(OpenID Connect)로 전환하라.
아래의 {ISSUER}, {SCOPES} 는 첫 줄의 값으로 바꿔 읽어라.
지금 인증은 자체 인증(아이디/비밀번호 등)이거나 Google OAuth를 직접 부르는 방식일 것이다.
전환 후에는 이 서비스가 비밀번호나 Google OAuth 클라이언트를 직접 다루지 않고, IdP가 발급한 id_token만 검증한다.

# 진행 방식

1. 조사: 코드를 바꾸기 전에 지금 인증 구조를 파악해 보고하라.
   - 로그인 진입점, 콜백, 세션 생성, 로그아웃, 인증 미들웨어, 사용자 테이블과 식별자(email, google_sub, username 등)
   - 비밀번호 저장, 회원가입, 비밀번호 재설정, 이메일 인증 같은 자체 인증 기능이 있는지
   - Google OAuth를 쓰면 client 설정, hd/도메인 검사, id_token 검증 코드 위치
   - 관련 환경 변수, 테스트, 문서
   - 사용하는 언어, 프레임워크, 배포 환경, 이미 쓰는 OIDC/JWT 라이브러리
2. 계획: 바꿀 파일과 순서, 기존 사용자 연결 방법, 지울 기능, 새 환경 변수를 정리해 보여주고 확인을 받아라.
3. 아래 "반드시 물어볼 것"은 내가 답하기 전에 진행하지 마라.
4. 구현하고, 테스트를 추가하거나 고쳐서 통과시켜라. 실제 IdP 없이 돌도록 IdP 응답은 테스트에서 흉내 낸다.
5. 끝나면 바뀐 점, 내가 손으로 해야 할 일, 확인하지 못한 것을 나눠서 보고하라.

# 반드시 물어볼 것

- 기존 사용자 계정을 IdP 사용자와 어떻게 연결할지. 기본 제안은 "email(소문자)로 연결하고, IdP sub를 별도 열에 저장"이다.
- 자체 인증의 비밀번호 해시, 회원가입, 비밀번호 재설정 기능과 데이터를 지울지, 비활성화만 할지, 언제 지울지.
  데이터 삭제(열 삭제, 마이그레이션의 DROP)는 내 확인 없이 하지 마라.
- 전환 기간에 기존 로그인을 함께 열어 둘지(병행) 바로 바꿀지(일괄).
- 학생 정보(학번, 소속, 소학회)가 정말 필요한지. 필요하면 어느 화면과 기능에 쓰는지.
  필요 없는 scope는 요청하지 않는다.
- @ajou.ac.kr이 아닌 계정(외부 관리자 등)이 지금 로그인할 수 있다면 그 사람들을 어떻게 할지.
  IdP는 @ajou.ac.kr Google Workspace 계정만 통과시킨다.

# B-CUBE IdP 규격

Discovery: {ISSUER}/.well-known/openid-configuration 을 먼저 읽어 아래 값과 같은지 확인하라.
값을 코드에 고정하지 말고 issuer 하나만 설정으로 받아 discovery에서 읽거나, 아래 엔드포인트를 issuer에서 만들어 써라.

| 항목 | 값 |
| --- | --- |
| issuer | `{ISSUER}` |
| authorization_endpoint | `{ISSUER}/authorize` |
| token_endpoint | `{ISSUER}/token` |
| userinfo_endpoint | `{ISSUER}/userinfo` (보통 필요 없다. id_token에 모든 클레임이 있다) |
| jwks_uri | `{ISSUER}/jwks.json` |
| 흐름 | Authorization Code + PKCE. `code_challenge_method=S256` 필수. `state` 필수. `nonce` 권장(쓰면 id_token에서 확인) |
| response_type | `code`만 |
| 클라이언트 인증 | `client_secret_basic`(기본) 또는 `client_secret_post`. 등록할 때 정한 방식을 쓴다 |
| id_token 서명 | `ES256`. JWKS로 검증. `kid`가 바뀌면 JWKS를 다시 받는다 |
| 토큰 수명 | id_token, access_token 모두 5분. refresh_token 없음. id_token을 검증한 뒤 이 서비스의 자체 세션을 만든다 |
| 인가 응답 | `code`, `state`, `iss`가 온다. `iss`가 issuer와 같은지 확인한다(RFC 9207) |
| redirect_uri | 등록한 값과 글자 하나까지 같아야 한다. https만(localhost는 http 허용) |
| 동의 | IdP가 로그인할 때마다 동의 화면을 띄운다. `prompt=none`은 `login_required`로 거절된다 |

id_token 검증 항목: 서명(JWKS, ES256만 허용), `iss` = issuer, `aud` = client_id, `exp`, `nonce`(보냈으면).

scope와 클레임:

| scope | 클레임 |
| --- | --- |
| `openid` (필수) | `sub` (Google 계정 sub. 계정마다 고정) |
| `email` | `email` (항상 @ajou.ac.kr, 소문자), `email_verified` (항상 true) |
| `profile` | `name` (Google 계정 이름) |
| `student` | `student: { id, name, college, department, major, grade, status }` (모두 문자열, 빈 값은 빠짐) |
| `sohakoe` | `sohakoe_memberships: [{ name, year, semester, from, to }]` |

- `student`, `sohakoe`는 관리자 승인이 있어야 쓸 수 있다. 승인 전이거나 중지된 SP로 로그인하면 IdP가 자기 오류 화면을 띄우고 이 서비스로 돌아오지 않는다.
- id_token에는 `hd` 클레임이 없다. IdP가 이미 학교 Workspace 계정만 통과시키므로, 기존 hd 검사는 IdP issuer일 때 빼라.
  대신 `email`이 `@ajou.ac.kr`로 끝나는지는 방어적으로 한 번 더 확인해도 된다.

콜백에서 처리할 오류(`error` 쿼리):

| error | 뜻 | 처리 |
| --- | --- | --- |
| `access_denied` | 사용자가 동의를 거부했거나 Google 로그인을 취소 | 로그인 화면으로 돌려보내고 안내 |
| `unauthorized_client` | 동의하는 사이에 관리자가 SP를 중지함 | 관리자 문의 안내 |
| `invalid_request`, `invalid_scope`, `unsupported_response_type`, `login_required` | 요청 구성 오류 | 로그에 남기고 일반 오류 표시 |

토큰 엔드포인트 오류: `invalid_client`(401, 비밀값 오류 또는 SP 중지), `invalid_grant`(코드 만료·재사용·PKCE 불일치·redirect_uri 불일치).
인가 코드는 60초 안에 한 번만 쓸 수 있다.

로그아웃: IdP에는 로그아웃 엔드포인트가 없고 IdP 세션도 없다. 이 서비스의 세션만 끊으면 된다.

# 클라이언트 등록

`client_id`/`client_secret`이 아직 없으면 나에게 두 방법을 제시하라.

1. B-CUBE IdP 관리자에게 요청한다. 서비스 이름, redirect_uri 목록, 필요한 scope를 알려준다.
2. 관리자에게 받은 등록 토큰(initial access token)으로 직접 등록한다(RFC 7591). 내가 실행할 명령을 만들어 줘라.
   ```sh
   curl -sS {ISSUER}/register \
     -H "Authorization: Bearer $IAT" -H 'Content-Type: application/json' \
     -d '{"client_name":"<서비스 이름>","redirect_uris":["<콜백 주소>"],"scope":"{SCOPES}","token_endpoint_auth_method":"client_secret_basic","contacts":["<담당자 이메일>"]}'
   ```
   응답의 `client_secret`, `registration_access_token`은 한 번만 나온다. `b_cube_status`가 `pending`이면 관리자 승인을 기다린다.
   등록 정보 수정·삭제는 `registration_client_uri`에 `Authorization: Bearer <registration_access_token>`으로 GET/PUT/DELETE 한다(RFC 7592).

# 구현 원칙

- 이 저장소의 기존 스타일, 언어, 라이브러리, 주석 밀도를 따른다. 이미 쓰는 JWT/OIDC 라이브러리가 있으면 그것을 쓴다.
  없으면 해당 언어에서 널리 쓰는 라이브러리(예: Node/Workers는 `jose`) 하나만 더한다.
- 설정은 환경 변수로 받는다: issuer, client_id, client_secret, redirect_uri(또는 앱 origin).
  `client_secret`은 비밀 저장소(.env 계열, wrangler secret, 배포 플랫폼 secret)에만 두고 커밋하지 않는다.
  예시 파일(.env.example 등)에는 빈 값과 설명만 둔다.
- PKCE verifier, state, nonce는 요청마다 새로 만들고, 서버 쪽(서명·암호화한 HttpOnly 쿠키나 서버 세션)에 둔다. 한 번 쓰면 지운다.
- 쿠키는 HttpOnly, Secure(운영), SameSite=Lax. IdP에서 돌아오는 top-level GET에 쿠키가 실려야 하므로 Strict는 쓰지 않는다.
- 사용자 식별은 `sub`를 기준으로 하고, 기존 사용자 연결에만 email을 쓴다. 학생 정보 클레임은 필요한 것만 저장한다.
  학번 외의 학적 정보를 저장해야 하면 나에게 먼저 묻는다.
- 기존 Google OAuth를 쓰던 서비스라면 IdP `sub`가 Google `sub`와 같은 값이므로 기존 google_sub와 그대로 이어진다.
  단, 로컬 IdP의 개발용 가짜 로그인은 `dev-<email>` 형태의 sub를 준다.
- 개발용 가짜 로그인 같은 기존 개발 편의 기능이 있으면 유지하되, 운영에서 켜지지 않게 하는 안전장치도 유지한다.
- 자체 인증 코드(비밀번호 해시, 회원가입, 재설정 메일)는 내가 정한 방식대로 비활성화하거나 지운다.
  지운 기능을 가리키는 화면, 라우트, 환경 변수, 문서도 함께 정리한다.
- 문서(README, 설정 가이드)에 IdP 연동 방법, 환경 변수, 로컬 개발 방법을 적는다.

# 테스트

다음을 테스트로 확인하라. IdP는 테스트용 ES256 키로 서명한 가짜 토큰 응답과 JWKS로 흉내 낸다.

- 로그인 시작이 `{ISSUER}/authorize`로 가고 `response_type=code`, `code_challenge_method=S256`, `state`, `nonce`, 요청한 scope가 들어 있다.
- 정상 콜백: 코드 교환 → id_token 검증 → 세션 생성 → 기존 사용자 연결.
- 거절: state 불일치, `iss` 불일치, 서명 오류, `aud` 불일치, 만료, nonce 불일치, `error=access_denied`.
- 자체 인증 경로를 닫았다면 예전 로그인 라우트가 더는 세션을 만들지 않는다.

# 하지 말 것

- IdP를 거치지 않고 mhaksa나 Google을 이 서비스에서 직접 부르지 마라.
- `client_secret`이나 토큰을 로그, 에러 메시지, 프런트엔드 번들에 남기지 마라.
- id_token 서명 검증을 건너뛰거나 `alg`를 토큰 헤더에서 그대로 받아 쓰지 마라. ES256만 허용한다.
- 내 확인 없이 사용자 데이터를 지우거나, 커밋·푸시·배포하지 마라.
````
