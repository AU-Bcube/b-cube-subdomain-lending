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

export interface ApiErrorBody {
  error: { code: string; message: string };
}
