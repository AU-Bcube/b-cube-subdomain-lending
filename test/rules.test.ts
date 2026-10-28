import { describe, expect, it } from "vitest";
import {
  checkCnameTarget,
  checkName,
  checkNameFormat,
  checkNameHold,
  isPublicIPv4,
  isPublicIPv6,
  normalizeHostname,
  parseIPv4,
  parseIPv6,
  validateRecordSet,
  type NameHistoryEntry,
  type RecordInput,
} from "../shared/rules";
import { BANNED_WORDS } from "../worker/data/banned-words";
import { RESERVED_NAMES } from "../worker/data/reserved-names";

const ZONE = "b-cube.kr";
const lists = { reserved: new Set(RESERVED_NAMES), bannedWords: BANNED_WORDS };

describe("checkNameFormat", () => {
  it.each(["abc", "alice", "a1b", "my-blog", "a".repeat(32), "1a2", "abc123"])("허용: %s", (name) => {
    expect(checkNameFormat(name)).toBeNull();
  });

  it.each([
    ["너무 짧음", "ab"],
    ["너무 김", "a".repeat(33)],
    ["대문자", "Alice"],
    ["하이픈 시작", "-abc"],
    ["하이픈 끝", "abc-"],
    ["연속 하이픈", "a--b"],
    ["퓨니코드", "xn--abc"],
    ["숫자만", "123"],
    ["숫자만(긴)", "2024"],
    ["밑줄 시작", "_abc"],
    ["밑줄 포함", "a_bc"],
    ["점 포함", "a.bc"],
    ["와일드카드", "*.abc"],
    ["빈 문자열", ""],
    ["공백", "ab c"],
  ])("거부: %s", (_label, name) => {
    expect(checkNameFormat(name)).toBe("invalid_format");
  });
});

describe("checkName", () => {
  it.each(["www", "admin", "b-cube", "test", "api", "ns1"])("예약어 거부: %s", (name) => {
    expect(checkName(name, lists)).toBe("reserved");
  });

  it("EXTRA_RESERVED_NAMES 반영", () => {
    expect(checkName("festival", { ...lists, reserved: new Set([...RESERVED_NAMES, "festival"]) })).toBe("reserved");
  });

  it.each(["my-kakao", "naverblog", "google", "ajou-portal-login", "paypal1", "mybank"])(
    "금칙어 부분 문자열 거부: %s",
    (name) => {
      expect(checkName(name, lists)).toBe("banned_word");
    },
  );

  it("형식 오류가 예약어보다 먼저", () => {
    expect(checkName("_dmarc", lists)).toBe("invalid_format");
  });

  it("정상 이름", () => {
    expect(checkName("alice-blog", lists)).toBeNull();
  });
});

describe("checkNameHold", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const entry = (status: NameHistoryEntry["status"], endedDaysAgo: number | null, owner = "a@ajou.ac.kr") => ({
    ownerEmail: owner,
    status,
    endedAt: endedDaysAgo === null ? null : now - endedDaysAgo * DAY,
  });

  it("기록 없음", () => {
    expect(checkNameHold([], "a@ajou.ac.kr", now, 30)).toBeNull();
  });

  it.each(["active", "suspended"] as const)("%s이면 taken (소유자 본인도)", (status) => {
    expect(checkNameHold([entry(status, null)], "a@ajou.ac.kr", now, 30)).toBe("taken");
  });

  it.each(["expired", "released"] as const)("%s: 보류 기간 안에는 원래 소유자만", (status) => {
    const history = [entry(status, 10)];
    expect(checkNameHold(history, "a@ajou.ac.kr", now, 30)).toBeNull();
    expect(checkNameHold(history, "b@ajou.ac.kr", now, 30)).toBe("held");
  });

  it("revoked: 보류 기간 안에는 누구도 불가", () => {
    const history = [entry("revoked", 10)];
    expect(checkNameHold(history, "a@ajou.ac.kr", now, 30)).toBe("held");
    expect(checkNameHold(history, "b@ajou.ac.kr", now, 30)).toBe("held");
  });

  it("보류 기간 경계: 정확히 holdDays가 지나면 신청 가능", () => {
    expect(checkNameHold([entry("revoked", 30)], "b@ajou.ac.kr", now, 30)).toBeNull();
    expect(checkNameHold([entry("revoked", 29.99)], "b@ajou.ac.kr", now, 30)).toBe("held");
  });

  it("NAME_HOLD_DAYS=0이면 보류 없음", () => {
    expect(checkNameHold([entry("revoked", 0)], "b@ajou.ac.kr", now, 0)).toBeNull();
  });
});

describe("IP 파싱", () => {
  it.each([
    ["1.2.3.4", 0x01020304],
    ["0.0.0.0", 0],
    ["255.255.255.255", 0xffffffff],
  ])("IPv4 %s", (ip, n) => {
    expect(parseIPv4(ip)).toBe(n);
  });

  it.each(["1.2.3", "1.2.3.4.5", "256.0.0.1", "01.2.3.4", "1.2.3.-4", "a.b.c.d", "1.2.3.4 ", ""])(
    "잘못된 IPv4: %s",
    (ip) => {
      expect(parseIPv4(ip)).toBeNull();
    },
  );

  it.each([
    ["::", 0n],
    ["::1", 1n],
    ["2001:db8::1", 0x20010db8000000000000000000000001n],
    ["::ffff:1.2.3.4", 0xffff01020304n],
    ["2606:4700:4700:0:0:0:0:1111", 0x26064700470000000000000000001111n],
    ["2606:4700:4700::1111", 0x26064700470000000000000000001111n],
  ])("IPv6 %s", (ip, n) => {
    expect(parseIPv6(ip)).toBe(n);
  });

  it.each(["1::2::3", "12345::", "g::1", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "fe80::1%eth0", "1.2.3.4::", ""])(
    "잘못된 IPv6: %s",
    (ip) => {
      expect(parseIPv6(ip)).toBeNull();
    },
  );
});

describe("공인 IP 판정 (대역 경계값)", () => {
  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255", // 10/8 직전
    "11.0.0.0", // 10/8 직후
    "100.63.255.255", // 100.64/10 직전
    "100.128.0.0", // 100.64/10 직후
    "172.15.255.255", // 172.16/12 직전
    "172.32.0.0", // 172.16/12 직후
    "192.0.1.0", // 192.0.0/24 직후
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255", // 198.18/15 직전
    "198.20.0.0", // 198.18/15 직후
    "223.255.255.255", // 224/4 직전
  ])("허용 IPv4: %s", (ip) => {
    expect(isPublicIPv4(ip)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.0",
    "10.255.255.255",
    "100.64.0.0",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.0",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.0",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("거부 IPv4: %s", (ip) => {
    expect(isPublicIPv4(ip)).toBe(false);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "2001:db7:ffff::1", "2001:db9::1", "fbff::1", "fe7f::1"])(
    "허용 IPv6: %s",
    (ip) => {
      expect(isPublicIPv6(ip)).toBe(true);
    },
  );

  it.each([
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "fc00::1",
    "fdff:ffff::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "2001:db8::1",
    "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
  ])("거부 IPv6: %s", (ip) => {
    expect(isPublicIPv6(ip)).toBe(false);
  });
});

describe("CNAME 값", () => {
  it("정규화: 소문자, 끝 점 제거", () => {
    expect(normalizeHostname(" Example.COM. ")).toBe("example.com");
    expect(checkCnameTarget("Foo.Example.com.", ZONE)).toEqual({ ok: true, value: "foo.example.com" });
  });

  it.each(["example.com", "a.b.c.example.co.kr", "xn--3e0b707e.com", "a-b.io"])("허용: %s", (v) => {
    expect(checkCnameTarget(v, ZONE).ok).toBe(true);
  });

  it.each([
    ["1.2.3.4", "cname_ip"],
    ["2001:4860::1", "cname_ip"],
    ["localhost", "cname_invalid"],
    ["-bad.com", "cname_invalid"],
    ["bad-.com", "cname_invalid"],
    ["a..com", "cname_invalid"],
    ["under_score.com", "cname_invalid"],
    ["example.123", "cname_invalid"],
    [`${"a".repeat(64)}.com`, "cname_invalid"],
    [`${"a.".repeat(126)}com`, "cname_invalid"], // 255자
    ["b-cube.kr", "cname_in_zone"],
    ["bob.b-cube.kr", "cname_in_zone"],
    ["BOB.B-CUBE.KR.", "cname_in_zone"],
  ])("거부: %s → %s", (v, code) => {
    expect(checkCnameTarget(v, ZONE)).toEqual({ ok: false, code });
  });

  it("존 이름이 접미사로만 겹치는 다른 도메인은 허용", () => {
    expect(checkCnameTarget("notb-cube.kr", ZONE).ok).toBe(true);
  });
});

describe("validateRecordSet", () => {
  const name = "alice";
  const fqdn = `${name}.${ZONE}`;
  const run = (targetKind: "vercel" | "ip" | "cname", records: RecordInput[]) =>
    validateRecordSet({ name, zone: ZONE, targetKind, records });
  const codes = (result: ReturnType<typeof run>) => (result.ok ? [] : result.errors.map((e) => e.code));

  describe("vercel", () => {
    it("기본 CNAME", () => {
      const result = run("vercel", [{ type: "CNAME", host: fqdn, content: "cname.vercel-dns.com" }]);
      expect(result).toEqual({
        ok: true,
        records: [{ type: "CNAME", host: fqdn, content: "cname.vercel-dns.com", proxied: true }],
      });
    });

    it("프로젝트별 CNAME 값과 검증 TXT", () => {
      const result = run("vercel", [
        { type: "cname", host: `${fqdn}.`, content: "D1D4FC829FE7BC7C.vercel-dns-017.com.", proxied: false },
        { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fqdn},abc123` },
      ]);
      expect(result).toEqual({
        ok: true,
        records: [
          { type: "CNAME", host: fqdn, content: "d1d4fc829fe7bc7c.vercel-dns-017.com", proxied: true },
          { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fqdn},abc123`, proxied: false },
        ],
      });
    });

    it("vercel-dns가 아닌 CNAME 거부", () => {
      expect(codes(run("vercel", [{ type: "CNAME", host: fqdn, content: "example.com" }]))).toEqual([
        "vercel_cname_invalid",
      ]);
      expect(codes(run("vercel", [{ type: "CNAME", host: fqdn, content: "vercel-dns.com.evil.com" }]))).toEqual([
        "vercel_cname_invalid",
      ]);
    });

    it("다른 lease의 FQDN으로 된 검증 TXT 거부", () => {
      const result = run("vercel", [
        { type: "CNAME", host: fqdn, content: "cname.vercel-dns.com" },
        { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=bob.${ZONE},abc` },
      ]);
      expect(codes(result)).toEqual(["vercel_txt_invalid"]);
    });

    it("접두사 뒤 쉼표 없이 이어지는 이름 거부 (alice.b-cube.kr.evil)", () => {
      const result = run("vercel", [
        { type: "CNAME", host: fqdn, content: "cname.vercel-dns.com" },
        { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fqdn}.evil,abc` },
      ]);
      expect(codes(result)).toEqual(["vercel_txt_invalid"]);
    });

    it("A 레코드와 _acme-challenge TXT는 허용하지 않음", () => {
      expect(
        codes(
          run("vercel", [
            { type: "CNAME", host: fqdn, content: "cname.vercel-dns.com" },
            { type: "A", host: fqdn, content: "1.1.1.1" },
            { type: "TXT", host: `_acme-challenge.${fqdn}`, content: "x" },
          ]),
        ),
      ).toEqual(["type_not_allowed", "host_not_allowed"]);
    });

    it("CNAME 0개 또는 2개 거부", () => {
      expect(codes(run("vercel", [{ type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fqdn},a` }]))).toEqual([
        "cname_count",
      ]);
      expect(
        codes(
          run("vercel", [
            { type: "CNAME", host: fqdn, content: "cname.vercel-dns.com" },
            { type: "CNAME", host: fqdn, content: "x.vercel-dns-017.com" },
          ]),
        ),
      ).toEqual(["cname_count"]);
    });
  });

  describe("ip", () => {
    it("A 2개 + AAAA 1개, 사용자 값과 무관하게 A/AAAA는 proxied, TXT는 아님", () => {
      const result = run("ip", [
        { type: "A", host: fqdn, content: "1.1.1.1", proxied: true },
        { type: "A", host: fqdn, content: "8.8.8.8", proxied: false },
        { type: "AAAA", host: fqdn, content: "2606:4700:4700::1111", proxied: true },
        { type: "TXT", host: fqdn, content: "google-site-verification=abc", proxied: true },
        { type: "TXT", host: `_acme-challenge.${fqdn}`, content: "token" },
      ]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.records.map((r) => r.proxied)).toEqual([true, true, true, false, false]);
    });

    it("AAAA만 1개", () => {
      expect(run("ip", [{ type: "AAAA", host: fqdn, content: "2606:4700:4700::1111" }]).ok).toBe(true);
    });

    it("A/AAAA 0개 거부", () => {
      expect(codes(run("ip", [{ type: "TXT", host: fqdn, content: "x" }]))).toEqual(["ip_count"]);
    });

    it("A 3개 거부", () => {
      const records = ["1.1.1.1", "8.8.8.8", "9.9.9.9"].map((content) => ({ type: "A", host: fqdn, content }));
      expect(codes(run("ip", records))).toEqual(["ip_count"]);
    });

    it("AAAA 3개 거부", () => {
      const records = ["2606:4700::1", "2606:4700::2", "2606:4700::3"].map((content) => ({ type: "AAAA", host: fqdn, content }));
      expect(codes(run("ip", records))).toEqual(["ip_count"]);
    });

    it("사설 IP, 잘못된 IP 거부", () => {
      expect(
        codes(
          run("ip", [
            { type: "A", host: fqdn, content: "192.168.0.1" },
            { type: "A", host: fqdn, content: "1.2.3" },
            { type: "AAAA", host: fqdn, content: "fe80::1" },
            { type: "AAAA", host: fqdn, content: "1.1.1.1" },
          ]),
        ),
      ).toEqual(["ip_not_public", "ip_invalid", "ip_not_public", "ip_invalid"]);
    });

    it("CNAME 거부, 다른 호스트 거부", () => {
      expect(
        codes(
          run("ip", [
            { type: "CNAME", host: fqdn, content: "example.com" },
            { type: "A", host: `www.${fqdn}`, content: "1.1.1.1" },
            { type: "A", host: `*.${fqdn}`, content: "1.1.1.1" },
            { type: "A", host: `bob.${ZONE}`, content: "1.1.1.1" },
          ]),
        ),
      ).toEqual(["type_not_allowed", "host_not_allowed", "host_not_allowed", "host_not_allowed"]);
    });

    it("중복 레코드 거부", () => {
      expect(
        codes(
          run("ip", [
            { type: "A", host: fqdn, content: "1.1.1.1" },
            { type: "A", host: fqdn, content: "1.1.1.1" },
          ]),
        ),
      ).toEqual(["duplicate"]);
    });
  });

  describe("cname", () => {
    it("CNAME + _acme-challenge TXT", () => {
      const result = run("cname", [
        { type: "CNAME", host: fqdn, content: "my-app.netlify.app.", proxied: false },
        { type: "TXT", host: `_acme-challenge.${fqdn}`, content: "token" },
      ]);
      expect(result).toEqual({
        ok: true,
        records: [
          { type: "CNAME", host: fqdn, content: "my-app.netlify.app", proxied: true },
          { type: "TXT", host: `_acme-challenge.${fqdn}`, content: "token", proxied: false },
        ],
      });
    });

    it("CNAME이 있는 호스트에 TXT 거부", () => {
      expect(
        codes(
          run("cname", [
            { type: "CNAME", host: fqdn, content: "example.com" },
            { type: "TXT", host: fqdn, content: "x" },
          ]),
        ),
      ).toEqual(["host_not_allowed"]);
    });

    it("존 하위 도메인 CNAME 거부 (회원 간 체인 방지)", () => {
      expect(codes(run("cname", [{ type: "CNAME", host: fqdn, content: `bob.${ZONE}` }]))).toEqual(["cname_in_zone"]);
    });

    it("_vercel TXT 거부", () => {
      expect(
        codes(
          run("cname", [
            { type: "CNAME", host: fqdn, content: "example.com" },
            { type: "TXT", host: `_vercel.${ZONE}`, content: `vc-domain-verify=${fqdn},a` },
          ]),
        ),
      ).toEqual(["host_not_allowed"]);
    });
  });

  describe("공통", () => {
    it.each(["NS", "MX", "SRV", "CAA", "PTR"])("%s 타입 거부", (type) => {
      expect(codes(run("ip", [{ type, host: fqdn, content: "x" }]))).toEqual(["type_not_allowed"]);
    });

    it("TXT 길이 경계값: 512자 허용, 513자 거부", () => {
      const ok = run("ip", [
        { type: "A", host: fqdn, content: "1.1.1.1" },
        { type: "TXT", host: fqdn, content: "a".repeat(512) },
      ]);
      expect(ok.ok).toBe(true);
      const tooLong = run("ip", [
        { type: "A", host: fqdn, content: "1.1.1.1" },
        { type: "TXT", host: fqdn, content: "a".repeat(513) },
      ]);
      expect(codes(tooLong)).toEqual(["txt_too_long"]);
    });

    it("TXT 비ASCII, 제어문자, 빈 값 거부", () => {
      expect(
        codes(
          run("ip", [
            { type: "A", host: fqdn, content: "1.1.1.1" },
            { type: "TXT", host: fqdn, content: "한글" },
            { type: "TXT", host: fqdn, content: "a\nb" },
            { type: "TXT", host: fqdn, content: "" },
          ]),
        ),
      ).toEqual(["txt_not_ascii", "txt_not_ascii", "txt_empty"]);
    });

    it("TXT 5개 허용, 6개 거부", () => {
      const txt = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ type: "TXT", host: i % 2 ? fqdn : `_acme-challenge.${fqdn}`, content: `v${i}` }));
      expect(run("ip", [{ type: "A", host: fqdn, content: "1.1.1.1" }, ...txt(5)]).ok).toBe(true);
      expect(codes(run("ip", [{ type: "A", host: fqdn, content: "1.1.1.1" }, ...txt(6)]))).toEqual(["txt_too_many"]);
    });

    it("오류의 index는 입력 순번", () => {
      const result = run("ip", [
        { type: "A", host: fqdn, content: "1.1.1.1" },
        { type: "A", host: fqdn, content: "10.0.0.1" },
      ]);
      expect(result.ok ? [] : result.errors).toEqual([expect.objectContaining({ index: 1, code: "ip_not_public" })]);
    });
  });
});
