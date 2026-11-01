/**
 * 회원 정보 삭제: 본인 탈퇴와 관리자 삭제가 함께 쓴다.
 *
 * 1) 남은 서브도메인을 끝내고 Cloudflare 레코드를 지운다. 실패하면 멈춘다(DB부터 지우면 레코드가 주인 없이 남는다). 다시 실행하면 이어서 처리한다.
 * 2) 사용자와 세션을 지운다. lease에는 삭제 시각만 표시해, 같은 계정으로 다시 로그인해도 보이지 않게 한다.
 * lease(소유자 이메일 포함), DNS 레코드 내용, 감사 로그는 지우지 않는다.
 */
import { NO_ID, type Database } from "../db";
import { auditStatement } from "./audit";
import type { DnsClient } from "./cloudflare-dns";
import { countLiveLeases, getRecordsByLease, LeaseError, LIVE_STATUSES, removeFromCloudflare, type Actor, type LeaseRow } from "./leases";

export async function deleteAccount(
  db: Database,
  dns: DnsClient,
  email: string,
  opts: {
    action: "user.withdraw" | "admin.delete_user";
    actor: Actor;
    reason: string | null;
    /** 사용 중·일시 중지 lease를 끝낸다. 탈퇴는 반납, 관리자 삭제는 회수 */
    endLease: (lease: LeaseRow) => Promise<void>;
  },
): Promise<void> {
  const owned = await db.leases.find({ owner_email: email, owner_deleted_at: null }, NO_ID).sort({ created_at: 1 }).toArray();
  for (const lease of owned) {
    if (LIVE_STATUSES.includes(lease.status)) await opts.endLease(lease);
  }
  const leaseIds = owned.map((l) => l.id);
  const records = [...(await getRecordsByLease(db, leaseIds)).values()].flat();
  // 끝난 lease가 아직 참조하는 레코드도 지운다. 이미 지운 레코드는 건너뛴다.
  await removeFromCloudflare(db, dns, records);

  // 처리하는 동안 새로 만든 lease가 있으면 지우지 않는다.
  if ((await countLiveLeases(db, email)) > 0) {
    throw new LeaseError(409, "leases_changed", "처리 중에 새 서브도메인이 생겼습니다. 다시 시도해 주세요.");
  }

  const now = Date.now();
  await db.batch([
    db.write((session) => db.leases.updateMany({ id: { $in: leaseIds } }, { $set: { owner_deleted_at: now } }, { session })),
    db.write((session) => db.sessions.deleteMany({ email }, { session })),
    db.write((session) => db.users.deleteOne({ email }, { session })),
    auditStatement(db, {
      action: opts.action,
      actorEmail: opts.actor.email,
      actorRole: opts.actor.role,
      targetEmail: email,
      detail: { reason: opts.reason, leases: owned.map((l) => l.name) },
      ip: opts.actor.ip ?? null,
      userAgent: opts.actor.userAgent ?? null,
      at: now,
    }),
  ]);
}
