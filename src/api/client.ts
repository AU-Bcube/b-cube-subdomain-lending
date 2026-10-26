/**
 * fetch 래퍼. 상태 변경 요청에는 X-CSRF-Token을 자동으로 첨부한다 (SPEC §6.3).
 */
import type { ApiErrorBody } from "../../shared/schemas";

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const headers = new Headers(rest.headers);
  headers.set("Accept", "application/json");
  if (json !== undefined) headers.set("Content-Type", "application/json");
  if (!SAFE_METHODS.has(method) && csrfToken) headers.set("X-CSRF-Token", csrfToken);

  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      method,
      headers,
      credentials: "same-origin",
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "network_error", "서버에 연결할 수 없습니다.");
  }

  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? `요청이 실패했습니다 (${res.status})`);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
