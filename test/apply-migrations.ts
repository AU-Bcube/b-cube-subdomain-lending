import { applyD1Migrations, env } from "cloudflare:test";

// 이미 적용된 마이그레이션은 건너뛰므로 파일마다 실행해도 된다.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
