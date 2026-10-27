/**
 * 헬스체크 판정 (SPEC §10.2). 서브도메인 탈취(주인 없는 CNAME/IP) 방지용.
 *
 * - CNAME 계열(vercel/cname): DoH로 대상의 A/AAAA 확인 → `https://<fqdn>/` GET, 벤더별 "주인 없음" 신호는 실패
 * - IP 계열(ip): 각 IP의 443, 실패하면 80 포트 TCP 연결. 하나라도 성공하면 정상
 *
 * 외부 호출은 HealthDeps로 주입해 테스트에서 바꿀 수 있다.
 */
import { connect } from "cloudflare:sockets";
import type { TargetKind } from "../../shared/rules";

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
const HTTP_TIMEOUT_MS = 10_000;
const TCP_TIMEOUT_MS = 5_000;
const BODY_SNIFF_BYTES = 64 * 1024;

export interface HealthResult {
  ok: boolean;
  /** 사람이 읽는 한 줄 요약. DB last_health_detail과 감사 로그에 남는다. */
  detail: string;
}

export interface HealthDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** host:port로 TCP 연결이 열리면 true */
  tcpProbe: (hostname: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export interface HealthTarget {
  targetKind: TargetKind;
  /** `<name>.<zone>` */
  fqdn: string;
  records: ReadonlyArray<{ type: string; host: string; content: string }>;
}

/**
 * - `live`: DNS 레코드가 Cloudflare에 있는 상태(active). 서브도메인으로 직접 HTTP 요청한다.
 * - `target`: 레코드가 제거된 상태(suspended 재확인). 서브도메인은 응답하지 않으므로 대상만 확인한다.
 *   이 모드에서는 벤더 "주인 없음" 신호를 확인할 수 없다(docs/LIMITATIONS.md).
 */
export type HealthMode = "live" | "target";

// ---------------------------------------------------------------------------
// 벤더별 "주인 없음" 시그니처. 실제 응답으로 확인되지 않은 항목은 verified: false.
// ---------------------------------------------------------------------------

export interface VendorSignature {
  vendor: string;
  verified: boolean;
  /** 본문까지 봐야 하는 경우 true (404일 때만 본문을 읽는다) */
  needsBody: boolean;
  match: (res: Response, body: string | null) => boolean;
}

export const VENDOR_SIGNATURES: readonly VendorSignature[] = [
  {
    vendor: "Vercel",
    verified: false,
    needsBody: false,
    // 도메인이 프로젝트에 연결되지 않았거나 배포가 없으면 x-vercel-error: DEPLOYMENT_NOT_FOUND / NOT_FOUND
    match: (res) => /(^|_)NOT_FOUND$/.test(res.headers.get("x-vercel-error") ?? ""),
  },
  {
    vendor: "Netlify",
    verified: false,
    needsBody: true,
    match: (res, body) =>
      res.status === 404 && res.headers.has("x-nf-request-id") && /Not Found - Request ID/i.test(body ?? ""),
  },
  {
    vendor: "GitHub Pages",
    verified: false,
    needsBody: true,
    match: (res, body) => res.status === 404 && /There isn't a GitHub Pages site here/i.test(body ?? ""),
  },
];

async function readBodyPrefix(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < BODY_SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

export async function detectUnclaimed(res: Response): Promise<string | null> {
  const body = res.status === 404 && VENDOR_SIGNATURES.some((s) => s.needsBody) ? await readBodyPrefix(res) : null;
  for (const sig of VENDOR_SIGNATURES) {
    if (sig.match(res, body)) return sig.vendor;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 개별 검사
// ---------------------------------------------------------------------------

interface DohAnswer {
  Status?: number;
  Answer?: Array<{ type: number; data: string }>;
}

/** 대상 호스트의 A/AAAA가 있는지. CNAME 체인은 리졸버가 따라간다. */
export async function resolvesToAddress(deps: HealthDeps, host: string): Promise<HealthResult> {
  const query = async (type: "A" | "AAAA") => {
    const res = await deps.fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
    return (await res.json()) as DohAnswer;
  };
  let answers: DohAnswer[];
  try {
    answers = await Promise.all([query("A"), query("AAAA")]);
  } catch (err) {
    return { ok: false, detail: `DoH: ${host} 조회 실패 (${err instanceof Error ? err.message : String(err)})` };
  }
  if (answers.some((a) => a.Answer?.some((r) => r.type === 1 || r.type === 28))) {
    return { ok: true, detail: `DoH: ${host} 주소 있음` };
  }
  const nx = answers.some((a) => a.Status === 3);
  return { ok: false, detail: `DoH: ${host} ${nx ? "NXDOMAIN" : "A/AAAA 응답 없음"}` };
}

export async function httpProbe(deps: HealthDeps, fqdn: string): Promise<HealthResult> {
  let res: Response;
  try {
    res = await deps.fetch(`https://${fqdn}/`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, detail: `HTTP: 응답 없음 (${err instanceof Error ? err.name : String(err)})` };
  }
  const vendor = await detectUnclaimed(res);
  if (vendor) return { ok: false, detail: `HTTP ${res.status}: ${vendor} 주인 없음 응답` };
  await res.body?.cancel().catch(() => {});
  return { ok: true, detail: `HTTP ${res.status}` };
}

export async function ipProbe(deps: HealthDeps, ips: readonly string[]): Promise<HealthResult> {
  for (const ip of ips) {
    for (const port of [443, 80]) {
      if (await deps.tcpProbe(ip, port, TCP_TIMEOUT_MS)) {
        return { ok: true, detail: `TCP ${port} 연결 성공 (${ip})` };
      }
    }
  }
  return { ok: false, detail: `TCP 443/80 연결 실패 (${ips.join(", ") || "IP 없음"})` };
}

// ---------------------------------------------------------------------------

export async function checkHealth(target: HealthTarget, mode: HealthMode, deps: HealthDeps = defaultHealthDeps): Promise<HealthResult> {
  if (target.targetKind === "ip") {
    const ips = target.records.filter((r) => r.type === "A" || r.type === "AAAA").map((r) => r.content);
    return ipProbe(deps, ips);
  }
  const cname = target.records.find((r) => r.type === "CNAME");
  if (!cname) return { ok: false, detail: "CNAME 레코드 없음" };
  const dns = await resolvesToAddress(deps, cname.content);
  if (!dns.ok || mode === "target") return dns;
  return httpProbe(deps, target.fqdn);
}

async function tcpProbe(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  let socket;
  try {
    socket = connect({ hostname, port });
  } catch {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    socket.close().catch(() => {});
  }
}

export const defaultHealthDeps: HealthDeps = {
  fetch: (input, init) => fetch(input, init),
  tcpProbe,
};
