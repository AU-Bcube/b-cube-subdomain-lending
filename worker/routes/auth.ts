import { Hono } from "hono";
import { destroySession } from "../auth/session";
import { csrf } from "../middleware/csrf";
import { requestMeta, writeAudit } from "../services/audit";
import type { HonoEnv } from "../types";

export const authRoutes = new Hono<HonoEnv>()
  .get("/login", (c) => {
    if (!c.var.config.oauthConfigured) {
      // 개발 모드 + DEV_FAKE_LOGIN에서만 도달한다(그 외에는 env 파싱 단계에서 실패).
      return c.redirect("/login?error=oauth_not_configured", 302);
    }
    // TODO(M2): Google OAuth (Authorization Code + PKCE)
    return c.redirect("/login?error=oauth_failed", 302);
  })
  .post("/logout", csrf, async (c) => {
    const session = c.var.session;
    await destroySession(c, session);
    if (session) {
      await writeAudit(c.env.DB, {
        action: "auth.logout",
        actorEmail: session.email,
        actorRole: c.var.config.adminEmails.has(session.email) ? "admin" : "user",
        targetEmail: session.email,
        ...requestMeta(c),
      });
    }
    return c.json({ ok: true });
  });
