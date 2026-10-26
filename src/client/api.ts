export class ApiError extends Error {
  constructor(message: string, public status: number, public payload?: any) { super(message); }
}

// Every project has its own API and cookie on the same local service.
export const projectBasePath = typeof location === "undefined" ? "" : location.pathname.match(/^\/projects\/[a-f0-9]{16}(?=\/|$)/)?.[0] ?? "";
export function apiPath(path: string) { return path.startsWith("/api/") ? `${projectBasePath}${path}` : path; }

export async function hostApi<T = any>(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const response = await fetch(path, {
    signal: options?.signal,
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.message || payload.error || `Request failed (${response.status})`, response.status, payload);
  return payload as T;
}

export function api<T = any>(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> { return hostApi<T>(apiPath(path), body, options); }

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
