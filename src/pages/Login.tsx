import { Button, Column, Grid, InlineNotification, Tile } from "@carbon/react";
import { Navigate, useSearchParams } from "react-router-dom";
import logoEnDark from "../../assets/b-cube-subdomain-lending-en-dark-logo.png";
import logoEn from "../../assets/b-cube-subdomain-lending-en-logo.png";
import logoDark from "../../assets/b-cube-subdomain-lending-ko-dark-logo.png";
import logo from "../../assets/b-cube-subdomain-lending-ko-logo.png";
import { useSession } from "../session";

const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: "@ajou.ac.kr 계정만 이용할 수 있습니다.",
  email_unverified: "이메일 인증이 완료되지 않은 계정입니다.",
  sohakoe_required: "B-CUBE 소학회 회원만 이용할 수 있습니다.",
  banned: "이용이 제한된 계정입니다. 운영진에게 문의하세요.",
  oauth_state: "로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.",
  oauth_cancelled: "로그인이 취소되었습니다.",
  oauth_client_suspended: "로그인을 사용할 수 없습니다. 운영진에게 문의하세요.",
  oauth_failed: "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  oauth_not_configured: "OAuth 미설정 — 개발용 로그인을 사용하세요.",
};

export function LoginPage() {
  const { loading, me, dev } = useSession();
  const [params] = useSearchParams();
  const error = params.get("error");

  if (me) return <Navigate to="/" replace />;

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <div className="login-page">
          <div className="login-card">
            <Tile className="login-tile">
              <h1 className="login-logo">
                {/* App.tsx의 테마와 같은 기준으로 고른다. */}
                <picture className="login-logo-ko">
                  <source media="(prefers-color-scheme: dark)" srcSet={logoDark} />
                  <img src={logo} alt="B-CUBE 서브도메인 대여체계" width={3226} height={792} />
                </picture>
                <picture className="login-logo-en">
                  <source media="(prefers-color-scheme: dark)" srcSet={logoEnDark} />
                  <img src={logoEn} alt="" width={4354} height={792} />
                </picture>
              </h1>
              <p>B-CUBE 소학회원의 아주대학교 계정(@ajou.ac.kr)으로 로그인해 서브도메인을 빌릴 수 있습니다.</p>
              {error && (
                <InlineNotification
                  kind={error === "oauth_not_configured" ? "info" : "error"}
                  title={error === "oauth_not_configured" ? "안내" : "로그인할 수 없습니다"}
                  subtitle={ERROR_MESSAGES[error] ?? "로그인에 실패했습니다."}
                  hideCloseButton
                  lowContrast
                />
              )}
              <Button href="/auth/login" disabled={loading}>
                {loading ? "페이지 정보를 불러오고 있습니다." : "B-CUBE 계정으로 로그인"}
              </Button>
              <p>
                B-CUBE 서브도메인 대여체계는 직접 만든 웹사이트에 <strong className="nowrap">희망도메인.b-cube.kr</strong> 같은 나만의 주소를 붙일 수 있게 해 주는 서비스입니다.
              </p>
              <h2>서브도메인이 무엇인가요?</h2>
              <p>
                도메인은 웹사이트의 주소입니다. 서브도메인은 <span className="nowrap">b-cube.kr</span>처럼 이미 있는 도메인 앞에 이름을 붙여 만든 주소입니다. 도메인을 사 본 적이 없어도 원하는 이름을 고르고 화면의 안내를 따라 연결하면 됩니다.
              </p>
              <div className="login-video">
                {/* 세션 확인이 끝나면 로그인 화면이 다시 그려지므로, 영상을 두 번 불러오지 않게 확인 후에 넣는다. */}
                {!loading && (
                  <iframe
                    src="https://www.youtube-nocookie.com/embed/AADs1D9albs"
                    title="Vercel로 만든 웹사이트에 내 주소를 붙이는 방법 (YouTube 영상)"
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    referrerPolicy="strict-origin-when-cross-origin"
                    allowFullScreen
                  />
                )}
              </div>
              <h2>특징</h2>
              <ul>
                <li>
                  <strong>무료 대여</strong>: B-CUBE 소학회원에게 최대 3개까지 무료로 빌려 드립니다.
                </li>
              </ul>
              <p className="login-note">
                <a className="cds--link" href="https://github.com/AU-Bcube/b-cube-subdomain-lending">
                  소스 코드 (AGPL-3.0)
                </a>
              </p>
            </Tile>

            {dev && dev.personas.length > 0 && (
              <div className="dev-personas">
                <InlineNotification
                  kind="warning"
                  title="개발 모드"
                  subtitle="아래 버튼은 로컬 개발 환경에서만 표시되는 가짜 로그인입니다."
                  hideCloseButton
                  lowContrast
                />
                {dev.personas.map((p) => (
                  <Button key={p.as} kind="ghost" href={`/auth/dev-login?as=${encodeURIComponent(p.as)}`}>
                    {p.label} — {p.email}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Column>
    </Grid>
  );
}
