export async function filePayload(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), sha256 };
}
export const pathId = (id: unknown) => encodeURIComponent(String(id));
export function safeJson(value: unknown) {
  return JSON.stringify(value, (key, item) => /^(?:access_?token|refresh_?token|client_?secret|password|code|authorizationUrl|state)$/i.test(key) ? '[已隐藏]' : item, 2);
}
export const lines = (value: string) => value.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
