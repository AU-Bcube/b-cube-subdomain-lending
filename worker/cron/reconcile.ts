/**
 * 드리프트 점검 (SPEC §10.3). 매주 `30 18 * * SUN`.
 * Cloudflare의 `bcd:lease=` 레코드와 DB records(cf_record_id가 있는 행)를 비교한다. 자동 삭제는 하지 않는다.
 */
import { normalizeHostname, parseIPv6 } from "../../shared/rules";
import type { DriftItem } from "../../shared/schemas";
import { auditStatement } from "../services/audit";
import { LEASE_COMMENT_PREFIX, type CfDnsRecord, type DnsClient } from "../services/cloudflare-dns";
import type { RecordRow } from "../services/leases";

function leaseIdFromComment(comment: string | null): string | null {
  return comment?.startsWith(LEASE_COMMENT_PREFIX) ? comment.slice(LEASE_COMMENT_PREFIX.length) : null;
}

/** Cloudflare가 돌려주는 값과 DB 값을 같은 형태로 맞춘다. */
export function normalizeContent(type: string, content: string): string {
  switch (type) {
    case "CNAME":
      return normalizeHostname(content);
    case "AAAA": {
      const n = parseIPv6(content);
      return n === null ? content.toLowerCase() : n.toString(16);
    }
    case "TXT":
      // API가 TXT 값을 따옴표로 감싸 돌려주는 경우가 있다.
      return /^".*"$/s.test(content) ? content.slice(1, -1) : content;
    default:
      return content;
  }
}

export function diffRecords(cf: readonly CfDnsRecord[], db: readonly RecordRow[]): DriftItem[] {
  const items: DriftItem[] = [];
  const byCfId = new Map(cf.map((r) => [r.id, r]));
  const dbCfIds = new Set<string>();

  for (const row of db) {
    if (row.cf_record_id === null) continue;
    dbCfIds.add(row.cf_record_id);
    const remote = byCfId.get(row.cf_record_id);
    const base = { type: row.type, host: row.host, leaseId: row.lease_id, recordId: row.id, cfRecordId: row.cf_record_id };
    if (!remote) {
      items.push({ ...base, kind: "db_only", dbContent: row.content, cfContent: null, dbProxied: row.proxied === 1, cfProxied: null });
      continue;
    }
    const same =
      remote.type === row.type &&
      normalizeHostname(remote.name) === row.host &&
      normalizeContent(row.type, remote.content) === normalizeContent(row.type, row.content) &&
      remote.proxied === (row.proxied === 1);
    if (!same) {
      items.push({ ...base, kind: "mismatch", dbContent: row.content, cfContent: remote.content, dbProxied: row.proxied === 1, cfProxied: remote.proxied });
    }
  }
  for (const remote of cf) {
    if (dbCfIds.has(remote.id)) continue;
    items.push({
      kind: "cf_only",
      type: remote.type,
      host: normalizeHostname(remote.name),
      leaseId: leaseIdFromComment(remote.comment),
      recordId: null,
      cfRecordId: remote.id,
      dbContent: null,
      cfContent: remote.content,
      dbProxied: null,
      cfProxied: remote.proxied,
    });
  }
  return items;
}

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
