/** Thin fetch wrapper: same-origin cookies + CSRF double-submit header. */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function request<T>(method: string, path: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };

  if (method !== 'GET') {
    // The server compares this against the ds_csrf cookie it set at login.
    const csrf = readCookie('ds_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  // Never set content-type for FormData — the browser must add the boundary.
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const envelope = (payload as { error?: { code?: string; message?: string; requestId?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      envelope?.code ?? 'error',
      envelope?.message ?? `Request failed (${res.status})`,
      res.status,
      envelope?.requestId,
      envelope?.details,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form, true),
};
