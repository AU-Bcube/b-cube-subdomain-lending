import type { LeaseStatus, TargetKind } from "../../shared/rules";
import type { AuditAction, DriftItem } from "../../shared/schemas";

type TagType = "green" | "red" | "gray" | "purple" | "cool-gray" | "cyan" | "magenta" | "blue" | "teal" | "warm-gray";

export const LEASE_STATUS_LABELS: Record<LeaseStatus, { text: string; tag: TagType }> = {
  active: { text: "사용 중", tag: "green" },
  suspended: { text: "일시 중지", tag: "red" },
  expired: { text: "만료", tag: "gray" },
  revoked: { text: "회수됨", tag: "purple" },
  released: { text: "반납", tag: "cool-gray" },
};

export const TARGET_KIND_LABELS: Record<TargetKind, string> = {
  vercel: "Vercel",
  ip: "서버 IP",
  cname: "기타 CNAME",
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "auth.login": "로그인",
  "auth.login_denied": "로그인 거부",
  "auth.logout": "로그아웃",
  "lease.create": "생성",
  "lease.update_records": "레코드 교체",
  "lease.renew": "연장",
  "lease.release": "반납",
  "lease.recheck": "재확인",
  "lease.reactivate": "재활성화",
  "system.health_fail": "헬스체크 실패",
  "system.suspend": "일시 중지",
  "system.expire": "만료",
  "admin.revoke": "강제 회수",
  "admin.ban": "사용자 차단",
  "admin.unban": "차단 해제",
  "system.drift_detected": "드리프트 감지",
  "system.dns_repair": "DNS 자동 복구",
  "admin.dns_recover": "DNS 작업 수동 복구",
};

export const ACTOR_ROLE_LABELS = { user: "회원", admin: "관리자", system: "시스템" } as const;

export const DRIFT_KIND_LABELS: Record<DriftItem["kind"], { text: string; tag: TagType }> = {
  cf_only: { text: "Cloudflare에만 있음", tag: "purple" },
  db_only: { text: "DB에만 있음", tag: "cyan" },
  mismatch: { text: "내용 다름", tag: "red" },
};

/** 감사 로그 사유 코드 등 내부 값을 사람이 읽는 문구로 */
export const STATUS_REASON_LABELS: Record<string, string> = {
  health_check_failed: "헬스체크 연속 실패",
  user_banned: "사용자 차단",
  lease_expired: "대여 기간 만료",
  suspended_too_long: "일시 중지 기간 초과",
};
