type Level = 'debug' | 'info' | 'warn' | 'error';
const hidden = /^(apiKey|api_key|token|secret|password|authorization|cookie|key)$/i;
const scrub = (text: string) => text.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***').replace(/(\bBearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***').replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '***');
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string') return scrub(value);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, hidden.test(k) ? '已隐藏' : redact(v)]));
  return value;
}
export function describeError(error: unknown): string {
  const text = error instanceof Error ? String(error.message || error.name) : String(error);
  return scrub(text).slice(0, 500);
}
export function log(level: Level, event: string, fields: Record<string, unknown> = {}, sink: (line: string) => void = level === 'error' || level === 'warn' ? (line) => console.error(line) : (line) => console.log(line)): void {
  const record = { ts: new Date().toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) };
  sink(JSON.stringify(record));
}
