/**
 * 작업 실행 잠금 (SPEC §10.2). cron과 관리자 수동 실행이 같은 작업을 동시에 돌리지 않게 한다.
 * 잠금은 해제하지 않고 시간으로 만료된다. 함수가 중간에 끊겨도 잠금이 남지 않는다.
 */
import { isDuplicateKey, type Database } from "../db";

export const RECOVER_LOCK = "dns_ops_recover";
/** 작업 기록 복구 실행 뒤 다른 실행을 막는 시간 */
export const RECOVER_LOCK_MS = 3 * 60_000;

export type LockTrigger = "cron" | "manual";

export interface LockState {
  startedAt: number;
  trigger: LockTrigger;
  /** 다음 실행이 가능한 시각 */
  availableAt: number;
}

export async function getLock(db: Database, name: string, ms: number): Promise<LockState | null> {
  const row = await db.jobLocks.findOne({ name });
  return row ? { startedAt: row.started_at, trigger: row.trigger, availableAt: row.started_at + ms } : null;
}

/**
 * 마지막 실행이 `ms`보다 오래됐을 때만 잠금을 잡는다. 확인과 기록을 한 번의 upsert로 해서 동시 요청에도 하나만 성공한다.
 * 잡았으면 `{ ok: true }`, 아니면 현재 잠금 상태.
 */
export async function acquireLock(
  db: Database,
  name: string,
  trigger: LockTrigger,
  ms: number,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; lock: LockState }> {
  try {
    // 잠금이 아직 유효하면 조건에 맞는 문서가 없어 upsert가 name 유일 인덱스에 걸린다.
    await db.jobLocks.updateOne({ name, started_at: { $lte: now - ms } }, { $set: { started_at: now, trigger } }, { upsert: true });
    return { ok: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  const lock = await getLock(db, name, ms);
  return { ok: false, lock: lock ?? { startedAt: now, trigger, availableAt: now + ms } };
}
