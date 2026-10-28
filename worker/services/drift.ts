/**
 * DB records와 Cloudflare 레코드 비교 (SPEC §10.3). 주간 드리프트 점검, 상세 화면의 실제 상태 확인, 복구가 함께 쓴다.
 */
import { normalizeHostname, parseIPv6 } from "../../shared/rules";
import type { DriftItem } from "../../shared/schemas";
import { LEASE_COMMENT_PREFIX, type CfDnsRecord } from "./cloudflare-dns";
import type { RecordRow } from "./leases";

export function leaseIdFromComment(comment: string | null): string | null {
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

/** DB 행과 Cloudflare 레코드의 내용이 같은지 */
export function recordMatches(row: RecordRow, remote: CfDnsRecord): boolean {
  return (
    remote.type === row.type &&
    normalizeHostname(remote.name) === row.host &&
    normalizeContent(row.type, remote.content) === normalizeContent(row.type, row.content) &&
    remote.proxied === (row.proxied === 1)
  );
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
    if (!recordMatches(row, remote)) {
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
