/** 개발 전용 가짜 로그인 페르소나 (SPEC §4.2). 서버에서만 사용하며 운영 번들(SPA)에는 포함되지 않는다. */
export interface DevPersona {
  as: string;
  email: string;
  name: string;
  sub: string;
  label: string;
}

export const DEV_PERSONAS: readonly DevPersona[] = [
  { as: "user", email: "member1@ajou.ac.kr", name: "김멤버", sub: "dev-sub-member1", label: "일반 회원 (여러 상태의 서브도메인 보유)" },
  { as: "full", email: "member2@ajou.ac.kr", name: "박한도", sub: "dev-sub-member2", label: "한도(3개)에 도달한 회원" },
  { as: "new", email: "newbie@ajou.ac.kr", name: "이신입", sub: "dev-sub-newbie", label: "서브도메인이 없는 신규 회원" },
  { as: "admin", email: "admin@ajou.ac.kr", name: "최관리", sub: "dev-sub-admin", label: "관리자" },
  { as: "banned", email: "banned@ajou.ac.kr", name: "정차단", sub: "dev-sub-banned", label: "차단된 사용자 (로그인 거부 확인)" },
];
