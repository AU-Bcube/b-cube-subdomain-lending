import { defineConfig } from "vitest/config";

// vite.config.ts의 netlify() 플러그인을 불러오지 않도록 테스트 설정을 분리한다.
// 테스트는 Node에서 실행되며, 테스트용 MongoDB에 파일마다 새 DB를 만든다(test/global-setup.ts, test/env.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
