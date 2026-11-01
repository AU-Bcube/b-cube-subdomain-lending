import type { Config } from "@netlify/functions";
import { handleRequest } from "../../worker/index";
import { runtimeEnv } from "../../worker/runtime";

export default (request: Request) => handleRequest(request, runtimeEnv());

// 경로가 지정된 함수는 정적 파일과 _redirects의 SPA 폴백보다 먼저 처리된다.
export const config: Config = {
  path: ["/api/*", "/auth/*"],
};
