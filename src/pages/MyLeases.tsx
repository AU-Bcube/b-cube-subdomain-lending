import { Column, Grid, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper } from "@carbon/react";
import { useSession } from "../session";

// M1: 셸 확인용 임시 화면. 목록 UI는 M5에서 구현한다.
export function MyLeasesPage() {
  const { me } = useSession();
  if (!me) return null;
  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <h1 className="cds--type-heading-05 page-title">내 서브도메인</h1>
        <StructuredListWrapper aria-label="내 계정">
          <StructuredListBody>
            <StructuredListRow>
              <StructuredListCell>이메일</StructuredListCell>
              <StructuredListCell>{me.email}</StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell>이름</StructuredListCell>
              <StructuredListCell>{me.name ?? "-"}</StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell>권한</StructuredListCell>
              <StructuredListCell>{me.isAdmin ? "관리자" : "회원"}</StructuredListCell>
            </StructuredListRow>
            <StructuredListRow>
              <StructuredListCell>사용 중</StructuredListCell>
              <StructuredListCell>
                {me.limits.used} / {me.limits.max}
              </StructuredListCell>
            </StructuredListRow>
          </StructuredListBody>
        </StructuredListWrapper>
      </Column>
    </Grid>
  );
}
