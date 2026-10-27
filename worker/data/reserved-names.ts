/**
 * 예약어 (SPEC §7.1). 정확히 일치하는 이름을 막는다.
 * 운영 중 추가는 EXTRA_RESERVED_NAMES 환경 변수로 한다.
 */
export const RESERVED_NAMES: readonly string[] = [
  "www", "domain", "api", "admin", "administrator", "root", "mail", "email", "smtp", "imap", "pop", "pop3",
  "mx", "ns", "ns1", "ns2", "dns",
  "ftp", "sftp", "ssh", "vpn", "git", "gitlab", "github", "gitea", "blog", "docs", "doc", "wiki", "status",
  "cdn", "static", "assets",
  "media", "img", "auth", "login", "logout", "signin", "signup", "sso", "oauth", "account", "accounts", "id",
  "my", "console",
  "dashboard", "panel", "support", "help", "abuse", "postmaster", "hostmaster", "webmaster", "security", "noreply",
  "b-cube", "bcube", "ajou", "official", "notice", "test", "dev", "staging", "prod", "localhost", "autoconfig",
  "autodiscover", "wpad", "isatap", "_dmarc", "_domainkey",
];
