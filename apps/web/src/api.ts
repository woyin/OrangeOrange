export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public requestId?: string) { super(message); }
}
let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export async function api<T = any>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  const headers: Record<string,string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key ?? crypto.randomUUID();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const response = await fetch('/api/v1/' + path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(result.error?.code ?? 'HTTP_ERROR', result.error?.message ?? `请求失败（${response.status}）`, response.status, result.requestId);
  return result.data;
}
export function items(value: any): any[] { return Array.isArray(value) ? value : value?.items ?? []; }
