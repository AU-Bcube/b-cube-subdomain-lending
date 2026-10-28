/**
 * 서버·클라이언트 공용 zod 스키마와 타입.
 */
import { z } from "zod";
import { MAX_TXT_LENGTH, TARGET_KINDS, type LeaseStatus, type RecordType, type TargetKind } from "./rules";

export const meResponseSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  isAdmin: z.boolean(),
  csrfToken: z.string(),
  /** 서브도메인이 붙는 존 이름 (예: b-cube.kr) */
  zone: z.string(),
  limits: z.object({ max: z.number().int(), used: z.number().int() }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const devConfigSchema = z.object({
  fakeLogin: z.boolean(),
  dnsDryRun: z.boolean(),
  oauthConfigured: z.boolean(),
  personas: z.array(z.object({ as: z.string(), email: z.string(), label: z.string() })),
});
export type DevConfig = z.infer<typeof devConfigSchema>;

// ---------------------------------------------------------------------------
// lease 입력 (SPEC §9). 형태만 검사하고, 이름·레코드 규칙은 shared/rules.ts가 검사한다.
// ---------------------------------------------------------------------------

export const targetKindSchema = z.enum(TARGET_KINDS);

export const recordInputSchema = z.object({
  type: z.string().max(10),
  host: z.string().max(253),
  content: z.string().max(MAX_TXT_LENGTH * 2),
  proxied: z.boolean().optional(),
});

export const recordsSchema = z.array(recordInputSchema).min(1).max(20);

export const createLeaseSchema = z.object({
  name: z.string().max(64),
  targetKind: targetKindSchema,
  records: recordsSchema,
});
export type CreateLeaseInput = z.infer<typeof createLeaseSchema>;

export const replaceRecordsSchema = z.object({ records: recordsSchema });
export type ReplaceRecordsInput = z.infer<typeof replaceRecordsSchema>;

export const nameAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.enum(["invalid_format", "reserved", "banned_word", "taken", "held", "conflict"]).optional(),
});
export type NameAvailability = z.infer<typeof nameAvailabilitySchema>;

// ---------------------------------------------------------------------------
// 감사 로그 (SPEC §5)
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.login_denied",
  "auth.logout",
  "lease.create",
  "lease.update_records",
  "lease.renew",
  "lease.release",
  "lease.recheck",
  "lease.reactivate",
  "system.health_fail",
  "system.suspend",
  "system.expire",
  "admin.revoke",
  "admin.ban",
  "admin.unban",
  "system.drift_detected",
  "system.dns_repair",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type ActorRole = "user" | "admin" | "system";

// ---------------------------------------------------------------------------
// 관리자 API (SPEC §9)
// ---------------------------------------------------------------------------

export const reasonSchema = z.object({
  reason: z.string().trim().min(1, "사유를 입력하세요.").max(500, "사유는 500자 이하로 입력하세요."),
});
export const optionalReasonSchema = z.object({ reason: z.string().trim().max(500).optional() });

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RecordView {
  id: string;
  type: RecordType;
  host: string;
  content: string;
  proxied: boolean;
  /** Cloudflare에 실제로 있는지 (cf_record_id가 있는지) */
  live: boolean;
}

export interface AdminLeaseItem {
  id: string;
  name: string;
  ownerEmail: string;
  targetKind: TargetKind;
  status: LeaseStatus;
  statusReason: string | null;
  createdAt: number;
  expiresAt: number;
  endedAt: number | null;
  healthFailCount: number;
  lastHealthCheckAt: number | null;
  records: RecordView[];
}

export interface AdminUserItem {
  email: string;
  name: string | null;
  isAdmin: boolean;
  firstLoginAt: number;
  lastLoginAt: number;
  bannedAt: number | null;
  banReason: string | null;
  /** active + suspended */
  liveLeaseCount: number;
  totalLeaseCount: number;
}

export interface AuditLogItem {
  id: number;
  at: number;
  actorEmail: string | null;
  actorRole: ActorRole;
  action: AuditAction;
  leaseId: string | null;
  leaseName: string | null;
  targetEmail: string | null;
  detail: unknown;
  ip: string | null;
}

export interface DriftItem {
  kind: "cf_only" | "db_only" | "mismatch";
  type: string;
  host: string;
  leaseId: string | null;
  recordId: string | null;
  cfRecordId: string | null;
  dbContent: string | null;
  cfContent: string | null;
  dbProxied: boolean | null;
  cfProxied: boolean | null;
}

export interface DriftResponse {
  run: { id: number; at: number; ok: boolean; driftCount: number; items: DriftItem[]; error: string | null } | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// 사용자 lease API (SPEC §9)
// ---------------------------------------------------------------------------

export interface LeaseItem {
  id: string;
  name: string;
  fqdn: string;
  targetKind: TargetKind;
  status: LeaseStatus;
  statusReason: string | null;
  createdAt: number;
  expiresAt: number;
  endedAt: number | null;
  healthFailCount: number;
  lastHealthCheckAt: number | null;
  lastHealthOkAt: number | null;
  lastHealthDetail: string | null;
  /** 지금 연장할 수 있는지 (만료 RENEW_WINDOW_DAYS 이내) */
  renewable: boolean;
  records: RecordView[];
}

/** 소유자에게 보여주는 감사 로그. 작업자 이메일과 IP는 노출하지 않는다. */
export interface LeaseAuditItem {
  id: number;
  at: number;
  actorRole: ActorRole;
  action: AuditAction;
  detail: unknown;
}

export interface LeaseDetail extends LeaseItem {
  auditLogs: LeaseAuditItem[];
}

export interface LeasesResponse {
  items: LeaseItem[];
  renewWindowDays: number;
}

export interface RecheckResponse {
  ok: boolean;
  detail: string;
  reactivated: boolean;
}

/** 레코드 검증 실패 시 에러 본문에 붙는 항목별 오류 */
export interface RecordFieldError {
  index?: number;
  code: string;
  message: string;
}
