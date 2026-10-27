/**
 * 서버·클라이언트 공용 zod 스키마와 타입.
 */
import { z } from "zod";
import { MAX_TXT_LENGTH, TARGET_KINDS } from "./rules";

export const meResponseSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  isAdmin: z.boolean(),
  csrfToken: z.string(),
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
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type ActorRole = "user" | "admin" | "system";

export interface ApiErrorBody {
  error: { code: string; message: string };
}
