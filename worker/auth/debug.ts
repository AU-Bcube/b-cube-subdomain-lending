/**
 * /auth/debug(개발 전용)가 보여줄 마지막 로그인의 ID 토큰 클레임.
 * DEV_AUTH_DEBUG=true + localhost에서만 기록한다. isolate 메모리에만 두므로 dev 서버 재시작 시 사라진다.
 */
import type { GoogleClaims } from "./idp";

export interface DebugClaims {
  at: number;
  email: string;
  email_verified: boolean;
  hd: string | null;
}

let last: DebugClaims | null = null;

export function recordDebugClaims(claims: GoogleClaims): void {
  last = { at: Date.now(), email: claims.email, email_verified: claims.email_verified, hd: claims.hd ?? null };
}

export function lastDebugClaims(): DebugClaims | null {
  return last;
}
