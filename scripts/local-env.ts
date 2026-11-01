/**
 * 스크립트 공용: .env를 읽고 DB에 연결한다.
 * localhost가 아닌 DB에 쓰는 스크립트는 `--remote`로 의도를 밝혀야 한다. 접속 문자열은 비밀이므로 출력하지 않는다.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type Database } from "../worker/db";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadDotEnv(): void {
  const file = join(ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function isLocalUri(uri: string): boolean {
  return /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])([:/,?]|$)/.test(uri);
}

export function connectionFromEnv(): { uri: string; name: string } {
  const uri = process.env.DB_CONNECTION_STRING ?? "";
  const name = process.env.DB_NAME ?? "";
  if (!uri || !name) {
    console.error("DB_CONNECTION_STRING과 DB_NAME을 .env에 넣으세요.");
    process.exit(1);
  }
  return { uri, name };
}

/** localhost가 아닌 DB면 `--remote` 없이는 멈춘다. */
export function openScriptDatabase(what: string): Database {
  const { uri, name } = connectionFromEnv();
  if (!isLocalUri(uri) && !process.argv.includes("--remote")) {
    console.error(`DB_CONNECTION_STRING이 원격 DB입니다(DB_NAME: ${name}). ${what}을(를) 원격에 실행하려면 --remote를 붙이세요.`);
    process.exit(1);
  }
  return openDatabase(uri, name);
}
