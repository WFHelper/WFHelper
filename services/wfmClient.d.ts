/** Type declarations for services/wfmClient.js */

export interface WfmRequestOptions {
  json?: unknown;
  headers?: Record<string, string>;
}

export interface WfmApiError extends Error {
  code?: string;
  status?: number;
}

export interface WfmRawResponse {
  res: {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    text(): Promise<string>;
  };
  body: unknown;
}

export function request(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts?: WfmRequestOptions,
): Promise<unknown>;

export function requestV2(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts?: WfmRequestOptions,
): Promise<unknown>;

export function requestRaw(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts?: WfmRequestOptions,
): Promise<WfmRawResponse>;

export function setTokenProvider(fn: () => string | null): void;
export function clearCsrfToken(): void;
export function updateCsrfFromToken(token: string): void;
