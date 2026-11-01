import { afterAll } from "vitest";
import { env } from "./env";

// 테스트 파일마다 새 DB이므로 매번 인덱스를 만든다.
await env.DB.ensureIndexes();

afterAll(() => env.DB.close());
