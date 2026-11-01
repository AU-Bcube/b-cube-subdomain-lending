/**
 * 인덱스 적용(worker/db.ts의 INDEXES). 여러 번 실행해도 된다.
 * 유일 인덱스가 이름 중복과 잠금을 막으므로, 앱을 쓰기 전에 한 번은 실행해야 한다.
 */
import { loadDotEnv, openScriptDatabase } from "./local-env";

loadDotEnv();
const db = openScriptDatabase("인덱스 적용");
try {
  const applied = await db.ensureIndexes();
  console.log(`✔ 인덱스 적용: ${applied.join(", ")}`);
} finally {
  await db.close();
}
