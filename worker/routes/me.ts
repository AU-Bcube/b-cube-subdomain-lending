import { Hono } from "hono";
import { withdrawSchema, type MeResponse } from "../../shared/schemas";
import { clearSessionCookie } from "../auth/session";
import { apiError } from "../lib/http";
import { requireUser } from "../middleware/auth";
import { deleteAccount } from "../services/account";
import { requestMeta } from "../services/audit";
import { createDnsClient, DnsError } from "../services/cloudflare-dns";
import { LeaseError, releaseLease, type Actor } from "../services/leases";
import type { HonoEnv } from "../types";

export const meRoutes = new Hono<HonoEnv>()
  .get("/", requireUser, async (c) => {
  const user = c.var.user;
  const used = await c.env.DB.leases.countDocuments({ owner_email: user.email, status: { $in: ["active", "suspended"] } });
  const body: MeResponse = {
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    csrfToken: user.csrfToken,
    zone: c.var.config.zoneName,
    limits: { max: c.var.config.maxLeasesPerUser, used },
    consentUrl: c.var.config.idpIssuer ? `${c.var.config.idpIssuer}/consents` : null,
  };
  return c.json(body);
  })

  // 회원 탈퇴: 남은 서브도메인을 반납하고 회원 정보를 삭제한다. 감사 로그는 남는다.
  .delete("/", requireUser, async (c) => {
    const user = c.var.user;
    const input = withdrawSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success || input.data.confirmEmail !== user.email) {
      return apiError(c, 400, "invalid_confirmation", "확인용 이메일이 일치하지 않습니다.");
    }
    const db = c.env.DB;
    const dns = createDnsClient(c.var.config);
    const actor: Actor = { email: user.email, role: "user", ...requestMeta(c) };
    try {
      await deleteAccount(db, dns, user.email, {
        action: "user.withdraw",
        actor,
        reason: null,
        endLease: (lease) => releaseLease(db, dns, lease, actor),
      });
    } catch (err) {
      if (err instanceof LeaseError) return apiError(c, 409, err.code, err.message);
      if (err instanceof DnsError) return apiError(c, 502, "dns_error", err.message);
      throw err;
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
