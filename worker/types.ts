import type { Config } from "./env";

export interface SessionInfo {
  idHash: string;
  email: string;
  name: string | null;
  csrfToken: string;
  expiresAt: number;
  bannedAt: number | null;
}

export interface CurrentUser {
  email: string;
  name: string | null;
  isAdmin: boolean;
  csrfToken: string;
}

export interface HonoEnv {
  Bindings: Env;
  Variables: {
    config: Config;
    session: SessionInfo | null;
    user: CurrentUser;
  };
}
