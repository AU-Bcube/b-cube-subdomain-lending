import { Button, Column, Grid, InlineNotification, Stack, Tile } from "@carbon/react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useSession } from "../session";

const ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: "@ajou.ac.kr 계정만 이용할 수 있습니다.",
  email_unverified: "이메일 인증이 완료되지 않은 Google 계정입니다.",
  hd_mismatch: "아주대학교 Google Workspace 계정으로 로그인해 주세요.",
  banned: "이용이 제한된 계정입니다. 운영진에게 문의하세요.",
  oauth_state: "로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.",
  oauth_failed: "Google 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  oauth_not_configured: "OAuth 미설정 — 개발용 로그인을 사용하세요.",
};

export function LoginPage() {
  const { me, dev } = useSession();
  const [params] = useSearchParams();
  const error = params.get("error");

  if (me) return <Navigate to="/" replace />;

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <div className="login-page">
          <div className="login-card">
            <Tile className="login-tile">
              <Stack gap={5}>
                <h1 className="cds--type-heading-04">B-CUBE Domain</h1>
                <p className="cds--type-body-01">
                  아주대 동아리 B-CUBE 회원을 위한 <strong>b-cube.kr</strong> 서브도메인 대여 콘솔입니다.
                  <br />
                  @ajou.ac.kr 계정만 이용 가능합니다.
                </p>
                {error && (
                  <InlineNotification
                    kind={error === "oauth_not_configured" ? "info" : "error"}
                    title={error === "oauth_not_configured" ? "안내" : "로그인할 수 없습니다"}
                    subtitle={ERROR_MESSAGES[error] ?? "로그인에 실패했습니다."}
                    hideCloseButton
                    lowContrast
                  />
                )}
                <Button href="/auth/login">Google로 로그인</Button>
              </Stack>
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
