/**
 * 로컬 D1 원클릭 초기화: 로컬 D1 상태 삭제 → 마이그레이션 → 시드.
 * `.wrangler/state/v3/d1`(로컬 전용)만 지운다. remote DB는 건드리지 않는다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const D1_STATE = join(ROOT, ".wrangler", "state", "v3", "d1");

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, CI: "1" } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (existsSync(D1_STATE)) {
  rmSync(D1_STATE, { recursive: true, force: true });
  console.log(`✔ 로컬 D1 상태 삭제: ${D1_STATE}`);
}
console.log("ℹ 개발 서버(npm run dev)가 실행 중이었다면 재시작하세요.");

run(join(ROOT, "node_modules", ".bin", "wrangler"), ["d1", "migrations", "apply", "bcube-domain", "--local"]);
run(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "seed.ts")]);
