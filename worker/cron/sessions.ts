/**
 * 만료된 세션 행 정리. 만료 세션은 조회 단계(loadSession)에서 이미 걸러지므로 보안 목적이 아니라 테이블 정리용이다.
 */
import type { Database } from "../db";

export async function purgeExpiredSessions(db: Database, now = Date.now()): Promise<number> {
  const result = await db.sessions.deleteMany({ expires_at: { $lte: now } });
  return result.deletedCount;
}
