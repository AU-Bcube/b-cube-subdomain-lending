import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../worker/env";
import { createDnsClient, DnsError } from "../worker/services/cloudflare-dns";

const liveConfig = () =>
  parseConfig({ ...env, DNS_DRY_RUN: "false", CF_ZONE_ID: "zone123", CF_API_TOKEN: "secret-token" } as Env);

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Captured[] = [];
  const fetcher = async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const next = responses.shift() ?? { body: { success: true, result: null } };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { calls, fetcher };
}

describe("cloudflare-dns", () => {
  it("dry-run: 네트워크 호출 없이 dry_ id 반환", async () => {
    const { calls, fetcher } = fakeFetch([]);
    const dns = createDnsClient(parseConfig(env), fetcher);
    expect(dns.dryRun).toBe(true);
    const id = await dns.create({ type: "A", name: "a.b-cube.kr", content: "1.1.1.1", proxied: false }, "lease-1");
    expect(id).toMatch(/^dry_[0-9a-f]{32}$/);
    await dns.remove(id);
    expect(await dns.listByName("a.b-cube.kr")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("create: 토큰 헤더, TTL 1, lease comment", async () => {
    const { calls, fetcher } = fakeFetch([{ body: { success: true, result: { id: "cf-1" } } }]);
    const dns = createDnsClient(liveConfig(), fetcher);
    const id = await dns.create({ type: "CNAME", name: "a.b-cube.kr", content: "example.com", proxied: false }, "lease-1");
    expect(id).toBe("cf-1");
    expect(calls[0]).toMatchObject({
      url: "https://api.cloudflare.com/client/v4/zones/zone123/dns_records",
      method: "POST",
      body: { type: "CNAME", name: "a.b-cube.kr", content: "example.com", ttl: 1, proxied: false, comment: "bcd:lease=lease-1" },
    });
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("remove: 이미 없는 레코드(404)는 성공으로 처리", async () => {
    const { calls, fetcher } = fakeFetch([{ status: 404, body: { success: false, errors: [{ code: 81044, message: "Record does not exist." }] } }]);
    await createDnsClient(liveConfig(), fetcher).remove("cf-9");
    expect(calls[0]).toMatchObject({ method: "DELETE", url: expect.stringMatching(/\/dns_records\/cf-9$/) });
  });

  it("실패 시 Cloudflare 메시지를 노출하지 않는 DnsError", async () => {
    const { fetcher } = fakeFetch([{ status: 400, body: { success: false, errors: [{ code: 9000, message: "internal detail zone123" }] } }]);
    const err = await createDnsClient(liveConfig(), fetcher)
      .create({ type: "A", name: "a.b-cube.kr", content: "1.1.1.1", proxied: false }, "l")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsError);
    expect((err as Error).message).not.toContain("internal detail");
  });

  it("listManaged: comment 접두사 필터와 페이지 순회", async () => {
    const rec = (id: string) => ({ id, type: "A", name: "a.b-cube.kr", content: "1.1.1.1", proxied: false, comment: "bcd:lease=x" });
    const { calls, fetcher } = fakeFetch([
      { body: { success: true, result: [rec("1")], result_info: { page: 1, total_pages: 2 } } },
      { body: { success: true, result: [rec("2")], result_info: { page: 2, total_pages: 2 } } },
    ]);
    const records = await createDnsClient(liveConfig(), fetcher).listManaged();
    expect(records.map((r) => r.id)).toEqual(["1", "2"]);
    expect(new URL(calls[0]!.url).searchParams.get("comment.startswith")).toBe("bcd:lease=");
    expect(new URL(calls[1]!.url).searchParams.get("page")).toBe("2");
  });
});
