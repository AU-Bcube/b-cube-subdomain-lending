/**
 * 만료된 세션 행 정리. 만료 세션은 조회 단계(loadSession)에서 이미 걸러지므로 보안 목적이 아니라 테이블 정리용이다.
 */
export async function purgeExpiredSessions(db: D1Database, now = Date.now()): Promise<number> {
  const result = await db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now).run();
  return result.meta.changes ?? 0;
}
