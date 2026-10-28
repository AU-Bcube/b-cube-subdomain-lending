/**
 * 서브도메인 이름과 DNS 레코드 검증 규칙 (SPEC §7). 서버·클라이언트 공용 순수 함수.
 *
 * - 예약어와 금칙어 목록은 worker/data에 있고, 호출하는 쪽에서 넘긴다.
 * - Cloudflare 조회가 필요한 동적 충돌 검사는 서버(lease 서비스)에서 한다.
 */

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const TARGET_KINDS = ["vercel", "ip", "cname"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const LEASE_STATUSES = ["active", "suspended", "expired", "revoked", "released"] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

/** Cloudflare 자동 TTL */
export const RECORD_TTL = 1;
export const MAX_TXT_RECORDS = 5;
export const MAX_TXT_LENGTH = 512;
export const MAX_IP_RECORDS_PER_TYPE = 2;
export const VERCEL_DEFAULT_CNAME = "cname.vercel-dns.com";

// ---------------------------------------------------------------------------
// 이름 (§7.1)
// ---------------------------------------------------------------------------

export type NameRejectReason = "invalid_format" | "reserved" | "banned_word" | "taken" | "held" | "conflict";

export const NAME_REASON_MESSAGES: Record<NameRejectReason, string> = {
  invalid_format: "3~32자의 영문 소문자, 숫자, 하이픈만 쓸 수 있습니다. 하이픈으로 시작·끝나거나 연속될 수 없고, 숫자로만 된 이름은 안 됩니다.",
  reserved: "예약된 이름입니다.",
  banned_word: "사용할 수 없는 단어가 포함되어 있습니다.",
  taken: "이미 사용 중인 이름입니다.",
  held: "최근 반납·만료·회수된 이름이라 일정 기간 신청할 수 없습니다.",
  conflict: "이 이름에 이미 다른 DNS 레코드가 있습니다.",
};

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;

/** 형식만 검사한다. 통과하면 null. */
export function checkNameFormat(name: string): "invalid_format" | null {
  if (!NAME_PATTERN.test(name)) return "invalid_format";
  if (name.includes("--")) return "invalid_format"; // xn-- 퓨니코드 포함
  if (/^[0-9]+$/.test(name)) return "invalid_format";
  if (name.startsWith("_")) return "invalid_format";
  return null;
}

export interface NameLists {
  reserved: ReadonlySet<string>;
  bannedWords: readonly string[];
}

/** 형식, 예약어, 금칙어를 검사한다. 통과하면 null. */
export function checkName(name: string, lists: NameLists): "invalid_format" | "reserved" | "banned_word" | null {
  const format = checkNameFormat(name);
  if (format) return format;
  if (lists.reserved.has(name)) return "reserved";
  if (lists.bannedWords.some((word) => word !== "" && name.includes(word))) return "banned_word";
  return null;
}

export interface NameHistoryEntry {
  ownerEmail: string;
  status: LeaseStatus;
  endedAt: number | null;
}

/**
 * 같은 이름의 기존 lease로 신청 가능 여부를 판단한다.
 * - active/suspended가 있으면 taken
 * - revoked 후 holdDays 이내면 누구도 신청 불가
 * - expired/released 후 holdDays 이내면 원래 소유자만 신청 가능
 */
export function checkNameHold(
  history: readonly NameHistoryEntry[],
  requesterEmail: string,
  now: number,
  holdDays: number,
): "taken" | "held" | null {
  const holdMs = holdDays * 24 * 60 * 60 * 1000;
  let held = false;
  for (const lease of history) {
    if (lease.status === "active" || lease.status === "suspended") return "taken";
    if (lease.endedAt === null || now - lease.endedAt >= holdMs) continue;
    if (lease.status === "revoked") held = true;
    else if (lease.ownerEmail !== requesterEmail) held = true;
  }
  return held ? "held" : null;
}

// ---------------------------------------------------------------------------
// IP (§7.2)
// ---------------------------------------------------------------------------

/** 점 표기 IPv4를 32비트 정수로. 앞자리 0은 8진수 혼동을 막기 위해 거부한다. */
export function parseIPv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** IPv6를 128비트 BigInt로. `::` 축약과 끝의 IPv4 표기를 지원하고, 영역 id(%)는 거부한다. */
export function parseIPv6(value: string): bigint | null {
  const v = value.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(v)) return null;
  const halves = v.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    const items = part.split(":");
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.includes(".")) {
        if (i !== items.length - 1) return null;
        const v4 = parseIPv4(item);
        if (v4 === null) return null;
        groups.push(Math.floor(v4 / 65536), v4 % 65536);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
        groups.push(parseInt(item, 16));
      }
    }
    return groups;
  };

  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  // 끝의 IPv4는 마지막에만 올 수 있다.
  if (halves.length === 2 && head.length > 0 && halves[0]!.includes(".")) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

type Cidr<T> = readonly [T, number];

const IPV4_BLOCKED: readonly Cidr<string>[] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["255.255.255.255", 32],
];

const IPV6_BLOCKED: readonly Cidr<string>[] = [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["2001:db8::", 32],
];

function inCidr(ip: bigint, net: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return ip >> shift === net >> shift;
}

/** 공인 IPv4인지. 사설·예약 대역이면 false. */
export function isPublicIPv4(value: string): boolean {
  const ip = parseIPv4(value);
  if (ip === null) return false;
  return !IPV4_BLOCKED.some(([net, prefix]) => inCidr(BigInt(ip), BigInt(parseIPv4(net)!), prefix, 32));
}

/** 공인 IPv6인지. 사설·예약 대역이면 false. */
export function isPublicIPv6(value: string): boolean {
  const ip = parseIPv6(value);
  if (ip === null) return false;
  return !IPV6_BLOCKED.some(([net, prefix]) => inCidr(ip, parseIPv6(net)!, prefix, 128));
}

// ---------------------------------------------------------------------------
// 호스트 이름 (§7.2)
// ---------------------------------------------------------------------------

/** 공백 제거, 소문자화, 끝의 점 하나 제거 */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 정규화된 FQDN인지. 라벨 2개 이상, 최상위 라벨은 숫자만으로 될 수 없다(IP 형태 배제). */
export function isValidFqdn(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL_PATTERN.test(label))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]!);
}

export function isZoneOrSubdomain(host: string, zone: string): boolean {
  return host === zone || host.endsWith(`.${zone}`);
}

export type CnameTargetError = "cname_invalid" | "cname_ip" | "cname_in_zone";

/** CNAME 값을 검사하고 정규화한다. */
export function checkCnameTarget(
  value: string,
  zone: string,
): { ok: true; value: string } | { ok: false; code: CnameTargetError } {
  const host = normalizeHostname(value);
  if (parseIPv4(host) !== null || parseIPv6(host) !== null) return { ok: false, code: "cname_ip" };
  if (!isValidFqdn(host)) return { ok: false, code: "cname_invalid" };
  if (isZoneOrSubdomain(host, zone)) return { ok: false, code: "cname_in_zone" };
  return { ok: true, value: host };
}

/**
 * Vercel이 안내하는 CNAME 값. SPEC은 `*.vercel-dns.com`이지만, Vercel 문서상 프로젝트별 값은
 * `d1d4fc829fe7bc7c.vercel-dns-017.com` 형태이므로 `vercel-dns-<숫자>.com`도 허용한다.
 */
const VERCEL_CNAME_PATTERN = /^(?:[a-z0-9-]+\.)+vercel-dns(?:-[0-9]{1,4})?\.com$/;

export function isVercelCnameTarget(host: string): boolean {
  return VERCEL_CNAME_PATTERN.test(host);
}

/** Vercel 도메인 접근 검증 TXT 값의 접두사. 값은 `_vercel.<zone>`에 둔다. */
export function vercelVerifyPrefix(fqdn: string): string {
  return `vc-domain-verify=${fqdn},`;
}

// ---------------------------------------------------------------------------
// 레코드 세트 (§7.2)
// ---------------------------------------------------------------------------

export interface RecordInput {
  type: string;
  host: string;
  content: string;
  proxied?: boolean | undefined;
}

export interface NormalizedRecord {
  type: RecordType;
  host: string;
  content: string;
  proxied: boolean;
}

export type RecordErrorCode =
  | "type_not_allowed"
  | "host_not_allowed"
  | "ip_invalid"
  | "ip_not_public"
  | CnameTargetError
  | "vercel_cname_invalid"
  | "vercel_txt_invalid"
  | "txt_empty"
  | "txt_too_long"
  | "txt_not_ascii"
  | "txt_too_many"
  | "cname_count"
  | "cname_exclusive"
  | "ip_count"
  | "duplicate";

export interface RecordError {
  /** 문제 레코드의 입력 순번. 세트 전체에 대한 오류면 없다. */
  index?: number;
  code: RecordErrorCode;
  message: string;
}

export const RECORD_ERROR_MESSAGES: Record<RecordErrorCode, string> = {
  type_not_allowed: "이 연결 대상에서 쓸 수 없는 레코드 타입입니다.",
  host_not_allowed: "이 연결 대상에서 쓸 수 없는 호스트입니다.",
  ip_invalid: "올바른 IP 주소가 아닙니다.",
  ip_not_public: "사설·예약 대역 IP는 쓸 수 없습니다. 공인 IP를 입력하세요.",
  cname_invalid: "올바른 도메인 이름이 아닙니다.",
  cname_ip: "CNAME 값에는 IP 주소를 쓸 수 없습니다.",
  cname_in_zone: "b-cube.kr 또는 그 하위 도메인은 CNAME 대상으로 쓸 수 없습니다.",
  vercel_cname_invalid: "Vercel이 안내한 *.vercel-dns.com 값을 입력하세요.",
  vercel_txt_invalid: "Vercel 검증 TXT는 이 서브도메인의 vc-domain-verify 값이어야 합니다.",
  txt_empty: "TXT 값을 입력하세요.",
  txt_too_long: `TXT 값은 ${MAX_TXT_LENGTH}자 이하여야 합니다.`,
  txt_not_ascii: "TXT 값에는 출력 가능한 ASCII 문자만 쓸 수 있습니다.",
  txt_too_many: `TXT 레코드는 최대 ${MAX_TXT_RECORDS}개입니다.`,
  cname_count: "CNAME 레코드가 정확히 1개 있어야 합니다.",
  cname_exclusive: "CNAME이 있는 호스트에는 다른 레코드를 둘 수 없습니다.",
  ip_count: `A, AAAA 레코드는 합쳐서 1개 이상, 타입별로 최대 ${MAX_IP_RECORDS_PER_TYPE}개입니다.`,
  duplicate: "같은 레코드가 중복되어 있습니다.",
};

/** target_kind별로 허용되는 (타입, 호스트) 조합 */
function allowedHosts(kind: TargetKind, fqdn: string, zone: string): Record<RecordType, readonly string[]> {
  const acme = `_acme-challenge.${fqdn}`;
  switch (kind) {
    case "vercel":
      return { A: [], AAAA: [], CNAME: [fqdn], TXT: [`_vercel.${zone}`] };
    case "ip":
      return { A: [fqdn], AAAA: [fqdn], CNAME: [], TXT: [fqdn, acme] };
    case "cname":
      return { A: [], AAAA: [], CNAME: [fqdn], TXT: [acme] };
  }
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export interface RecordSetInput {
  name: string;
  zone: string;
  targetKind: TargetKind;
  records: readonly RecordInput[];
}

/**
 * lease 하나의 레코드 세트를 검사하고 정규화한다.
 * proxied는 사용자 값과 무관하게 A/AAAA/CNAME은 true, TXT는 false로 강제한다(TXT는 프록시할 수 없다).
 */
export function validateRecordSet(
  input: RecordSetInput,
): { ok: true; records: NormalizedRecord[] } | { ok: false; errors: RecordError[] } {
  const { name, zone, targetKind } = input;
  const fqdn = `${name}.${zone}`;
  const allowed = allowedHosts(targetKind, fqdn, zone);
  const errors: RecordError[] = [];
  const fail = (code: RecordErrorCode, index?: number) =>
    errors.push(index === undefined ? { code, message: RECORD_ERROR_MESSAGES[code] } : { index, code, message: RECORD_ERROR_MESSAGES[code] });

  const records: NormalizedRecord[] = [];
  input.records.forEach((record, index) => {
    const type = record.type.trim().toUpperCase();
    if (!(RECORD_TYPES as readonly string[]).includes(type)) return fail("type_not_allowed", index);
    const rtype = type as RecordType;
    const host = normalizeHostname(record.host);
    if (allowed[rtype].length === 0) return fail("type_not_allowed", index);
    if (!allowed[rtype].includes(host)) return fail("host_not_allowed", index);

    let content = record.content.trim();
    switch (rtype) {
      case "A":
        if (parseIPv4(content) === null) return fail("ip_invalid", index);
        if (!isPublicIPv4(content)) return fail("ip_not_public", index);
        break;
      case "AAAA":
        content = content.toLowerCase();
        if (parseIPv6(content) === null) return fail("ip_invalid", index);
        if (!isPublicIPv6(content)) return fail("ip_not_public", index);
        break;
      case "CNAME": {
        const target = checkCnameTarget(content, zone);
        if (!target.ok) return fail(target.code, index);
        content = target.value;
        if (targetKind === "vercel" && !isVercelCnameTarget(content)) return fail("vercel_cname_invalid", index);
        break;
      }
      case "TXT":
        // TXT는 앞뒤 공백도 값의 일부일 수 있으므로 원래 값을 쓴다.
        content = record.content;
        if (content.length === 0) return fail("txt_empty", index);
        if (content.length > MAX_TXT_LENGTH) return fail("txt_too_long", index);
        if (!PRINTABLE_ASCII.test(content)) return fail("txt_not_ascii", index);
        if (host === `_vercel.${zone}` && !content.startsWith(vercelVerifyPrefix(fqdn))) {
          return fail("vercel_txt_invalid", index);
        }
        break;
    }
    const proxied = rtype !== "TXT";
    records.push({ type: rtype, host, content, proxied });
  });
  if (errors.length > 0) return { ok: false, errors };

  const count = (type: RecordType) => records.filter((r) => r.type === type).length;
  if (count("TXT") > MAX_TXT_RECORDS) fail("txt_too_many");
  if (targetKind === "ip") {
    const a = count("A");
    const aaaa = count("AAAA");
    if (a + aaaa < 1 || a > MAX_IP_RECORDS_PER_TYPE || aaaa > MAX_IP_RECORDS_PER_TYPE) fail("ip_count");
  } else if (count("CNAME") !== 1) {
    fail("cname_count");
  }
  const cnameHosts = new Set(records.filter((r) => r.type === "CNAME").map((r) => r.host));
  if (records.some((r) => r.type !== "CNAME" && cnameHosts.has(r.host))) fail("cname_exclusive");

  const seen = new Set<string>();
  records.forEach((r, index) => {
    const key = `${r.type}\n${r.host}\n${r.type === "TXT" ? r.content : r.content.toLowerCase()}`;
    if (seen.has(key)) fail("duplicate", index);
    seen.add(key);
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, records };
}
