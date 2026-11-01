/**
 * 로컬 DB 초기화: 앱 컬렉션 삭제 → 인덱스 → 시드.
 * localhost DB에서만 동작한다. 원격 DB는 지우지 않는다(--remote를 받지 않는다).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { INDEXES, openDatabase } from "../worker/db";
import { connectionFromEnv, isLocalUri, loadDotEnv, ROOT } from "./local-env";

loadDotEnv();
const { uri, name } = connectionFromEnv();
if (!isLocalUri(uri)) {
  console.error(`DB_CONNECTION_STRING이 원격 DB입니다(DB_NAME: ${name}). db:reset은 localhost DB 전용입니다.`);
  process.exit(1);
}

const db = openDatabase(uri, name);
try {
  await db.dropCollections(Object.keys(INDEXES));
} finally {
  await db.close();
}
console.log(`✔ 로컬 DB 초기화: ${name}`);

function run(script: string) {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", script)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("migrate.ts");
run("seed.ts");
