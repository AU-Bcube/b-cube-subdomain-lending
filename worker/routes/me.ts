import { Hono } from "hono";
import type { MeResponse } from "../../shared/schemas";
import { requireUser } from "../middleware/auth";
import type { HonoEnv } from "../types";

export const meRoutes = new Hono<HonoEnv>().get("/", requireUser, async (c) => {
  const user = c.var.user;
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS used FROM leases WHERE owner_email = ? AND status IN ('active','suspended')`,
  )
    .bind(user.email)
    .first<{ used: number }>();
  const body: MeResponse = {
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    csrfToken: user.csrfToken,
    limits: { max: c.var.config.maxLeasesPerUser, used: row?.used ?? 0 },
  };
  return c.json(body);
});
