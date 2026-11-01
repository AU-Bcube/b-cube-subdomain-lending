/**
 * 테스트용 MongoDB. 트랜잭션을 쓰므로 복제 세트로 띄운다.
 * .env의 실제 DB는 쓰지 않는다. 첫 실행 때 mongod 바이너리를 내려받는다.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup(project: TestProject) {
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  project.provide("mongoUri", server.getUri());
  return async () => {
    await server.stop();
  };
}
