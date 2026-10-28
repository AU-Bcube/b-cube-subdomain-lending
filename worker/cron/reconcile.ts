/**
 * 드리프트 점검 (SPEC §10.3). 매주 `30 18 * * SUN`.
 * Cloudflare의 `bcd:lease=` 레코드와 DB records(cf_record_id가 있는 행)를 비교한다. 자동 삭제는 하지 않는다.
 */
import { auditStatement } from "../services/audit";
import type { CfDnsRecord, DnsClient } from "../services/cloudflare-dns";
import { diffRecords } from "../services/drift";
import type { RecordRow } from "../services/leases";

export { diffRecords, normalizeContent } from "../services/drift";

export async function runReconcile(db: D1Database, dns: DnsClient, now = Date.now()): Promise<{ ok: boolean; driftCount: number }> {
  let cf: CfDnsRecord[];
  try {
    cf = await dns.listManaged();
  } catch (err) {
    console.error("[cron:reconcile] Cloudflare 조회 실패", err);
    await db
      .prepare(`INSERT INTO reconcile_runs (at, ok, drift_count, items, error) VALUES (?, 0, 0, '[]', ?)`)
      .bind(now, "Cloudflare 레코드 목록을 가져오지 못했습니다.")
      .run();
    return { ok: false, driftCount: 0 };
  }
  const { results } = await db.prepare(`SELECT * FROM records WHERE cf_record_id IS NOT NULL`).all<RecordRow>();
  const items = diffRecords(cf, results);
  // dry-run에서는 Cloudflare 목록이 항상 비어 있어 모든 레코드가 db_only로 보인다.
  const error = dns.dryRun ? "DNS_DRY_RUN: Cloudflare를 조회하지 않았습니다. 결과는 참고용입니다." : null;

  const [inserted] = await db.batch([
    db
      .prepare(`INSERT INTO reconcile_runs (at, ok, drift_count, items, error) VALUES (?, 1, ?, ?, ?) RETURNING id`)
      .bind(now, items.length, JSON.stringify(items), error),
  ]);
  const runId = (inserted?.results[0] as { id: number } | undefined)?.id ?? null;
  if (items.length > 0) {
    const counts = { cf_only: 0, db_only: 0, mismatch: 0 };
    for (const item of items) counts[item.kind]++;
    await auditStatement(db, {
      action: "system.drift_detected",
      actorEmail: null,
      actorRole: "system",
      detail: { runId, count: items.length, ...counts, dryRun: dns.dryRun },
      at: now,
    }).run();
  }
  return { ok: true, driftCount: items.length };
}
