import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// vite.config.ts의 cloudflare() 플러그인과 충돌하지 않도록 테스트 설정을 분리한다.
// 테스트는 workerd 안에서 실행된다.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // 개인 .dev.vars, 운영 값을 채운 wrangler.jsonc vars와 무관하게 테스트 설정을 고정한다.
        bindings: {
          APP_ORIGIN: "http://localhost:5173",
          DNS_DRY_RUN: "true",
          DEV_FAKE_LOGIN: "false",
          DEV_AUTH_DEBUG: "false",
          GOOGLE_CLIENT_ID: "test-client-id",
          GOOGLE_CLIENT_SECRET: "test-client-secret",
          CF_ZONE_ID: "",
          CF_API_TOKEN: "",
          ADMIN_EMAILS: "t-admin@ajou.ac.kr",
          REQUIRE_HD: "false",
          EXTRA_RESERVED_NAMES: "",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
