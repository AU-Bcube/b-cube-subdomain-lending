/**
 * Cloudflare DNS API 래퍼 (SPEC §8).
 *
 * - 레코드 comment에는 `bcd:lease=<leaseId>`만 기록한다. 개인정보는 넣지 않는다.
 * - DNS_DRY_RUN=true이면 네트워크를 호출하지 않고 `dry_<uuid>` id를 반환하며 로그만 남긴다.
 * - Cloudflare 오류 메시지는 서버 로그에만 남기고, 호출하는 쪽에는 DnsError(일반화된 메시지)를 던진다.
 */
import type { RecordType } from "../../shared/rules";
import { RECORD_TTL } from "../../shared/rules";
import type { Config } from "../env";

export const LEASE_COMMENT_PREFIX = "bcd:lease=";

export function leaseComment(leaseId: string): string {
  return `${LEASE_COMMENT_PREFIX}${leaseId}`;
}

export interface DnsRecordData {
  type: RecordType;
  /** FQDN */
  name: string;
  content: string;
  proxied: boolean;
}

export interface CfDnsRecord extends DnsRecordData {
  id: string;
  comment: string | null;
}

export class DnsError extends Error {
  override name = "DnsError";
  constructor(message = "DNS 레코드 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.") {
    super(message);
  }
}

export interface DnsClient {
  readonly dryRun: boolean;
  listByName(fqdn: string): Promise<CfDnsRecord[]>;
  create(record: DnsRecordData, leaseId: string): Promise<string>;
  update(id: string, record: DnsRecordData, leaseId: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** comment가 `bcd:lease=`로 시작하는 레코드 전부 */
  listManaged(): Promise<CfDnsRecord[]>;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; total_pages: number };
}

interface CfRawRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}

const PAGE_SIZE = 100;

function toRecord(raw: CfRawRecord): CfDnsRecord {
  return {
    id: raw.id,
    type: raw.type as RecordType,
    name: raw.name,
    content: raw.content,
    proxied: raw.proxied === true,
    comment: raw.comment ?? null,
  };
}

function body(record: DnsRecordData, leaseId: string) {
  return {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: RECORD_TTL,
    proxied: record.proxied,
    comment: leaseComment(leaseId),
  };
}

export function createDnsClient(config: Config, fetcher: Fetcher = (input, init) => fetch(input, init)): DnsClient {
  if (config.dnsDryRun) return dryRunClient();

  const base = `https://api.cloudflare.com/client/v4/zones/${config.cfZoneId}/dns_records`;

  async function call<T>(op: string, path: string, init: RequestInit = {}): Promise<CfEnvelope<T>> {
    let res: Response;
    try {
      res = await fetcher(`${base}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${config.cfApiToken}`, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error(`[dns] ${op} 네트워크 오류`, err);
      throw new DnsError();
    }
    const data = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (op === "remove" && res.status === 404) {
      // 이미 없는 레코드. 삭제 목적은 달성했으므로 성공으로 본다.
      console.warn(`[dns] remove: 이미 없는 레코드 ${path}`);
      return { success: true, result: null as T };
    }
    if (!res.ok || !data?.success) {
      console.error(`[dns] ${op} 실패 status=${res.status}`, JSON.stringify(data?.errors ?? null));
      throw new DnsError();
    }
    return data;
  }

  async function listAll(query: URLSearchParams): Promise<CfDnsRecord[]> {
    const out: CfDnsRecord[] = [];
    for (let page = 1; ; page++) {
      query.set("page", String(page));
      query.set("per_page", String(PAGE_SIZE));
      const data = await call<CfRawRecord[]>("list", `?${query}`);
      out.push(...data.result.map(toRecord));
      const totalPages = data.result_info?.total_pages ?? 1;
      if (page >= totalPages) return out;
    }
  }

  return {
    dryRun: false,
    listByName: (fqdn) => listAll(new URLSearchParams({ name: fqdn })),
    async create(record, leaseId) {
      const data = await call<CfRawRecord>("create", "", { method: "POST", body: JSON.stringify(body(record, leaseId)) });
      return data.result.id;
    },
    async update(id, record, leaseId) {
      await call("update", `/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body(record, leaseId)) });
    },
    async remove(id) {
      await call("remove", `/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    listManaged: () => listAll(new URLSearchParams({ "comment.startswith": LEASE_COMMENT_PREFIX })),
  };
}

function dryRunClient(): DnsClient {
  const log = (...args: unknown[]) => console.log("[dns:dry-run]", ...args);
  return {
    dryRun: true,
    async listByName(fqdn) {
      log("listByName", fqdn);
      return [];
    },
    async create(record, leaseId) {
      const id = `dry_${crypto.randomUUID().replace(/-/g, "")}`;
      log("create", id, record.type, record.name, record.content, `proxied=${record.proxied}`, leaseComment(leaseId));
      return id;
    },
    async update(id, record) {
      log("update", id, record.type, record.name, record.content);
    },
    async remove(id) {
      log("remove", id);
    },
    async listManaged() {
      log("listManaged");
      return [];
    },
  };
}
