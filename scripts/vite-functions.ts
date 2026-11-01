/**
 * 로컬 dev/preview 서버에서 `/api/*`, `/auth/*`를 Netlify 함수(netlify/functions/api.ts)로 보낸다.
 * 운영의 Netlify 라우팅과 같은 경로 규칙이다. .env 값은 process.env로 넣어 함수가 읽게 한다.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createServer, loadEnv, type Connect, type Plugin, type ViteDevServer } from "vite";

const FUNCTION_ENTRY = "/netlify/functions/api.ts";
const FUNCTION_PATH = /^\/(api|auth)(\/|\?|$)/;

type Handler = (request: Request) => Promise<Response>;

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // Node의 fetch는 스트림 본문에 duplex가 필요하다.
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function middleware(load: () => Promise<Handler>): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!FUNCTION_PATH.test(req.url ?? "")) return next();
    load()
      .then((handler) => handler(toRequest(req)))
      .then((response) => sendResponse(res, response))
      .catch(next);
  };
}

export function netlifyFunctions(): Plugin {
  return {
    name: "netlify-functions-local",
    config(_, { mode }) {
      Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
    },
    configureServer(server) {
      server.middlewares.use(
        middleware(async () => ((await server.ssrLoadModule(FUNCTION_ENTRY)) as { default: Handler }).default),
      );
    },
    configurePreviewServer(server) {
      // preview에는 모듈 로더가 없으므로 함수 코드만 읽는 vite 서버를 하나 더 띄운다.
      let loader: Promise<ViteDevServer> | undefined;
      server.middlewares.use(
        middleware(async () => {
          loader ??= createServer({
            configFile: false,
            root: server.config.root,
            appType: "custom",
            logLevel: "warn",
            server: { middlewareMode: true, hmr: false, ws: false },
          });
          const vite = await loader;
          return ((await vite.ssrLoadModule(FUNCTION_ENTRY)) as { default: Handler }).default;
        }),
      );
    },
  };
}
