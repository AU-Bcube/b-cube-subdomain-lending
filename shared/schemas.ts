/**
 * 서버·클라이언트 공용 zod 스키마와 타입.
 */
import { z } from "zod";

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
