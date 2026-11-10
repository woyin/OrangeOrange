import { SendFailure, type Fetch } from "./types.js";
export async function jsonRequest(
  fetcher: Fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeout = 15000,
): Promise<any> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
  } catch {
    throw new SendFailure(
      "unknown",
      signal.aborted ? "interrupted" : "network_result_unknown",
    );
  }
  if (response.status === 429) {
    await response.body?.cancel();
    const seconds = Number(response.headers.get("retry-after"));
    throw new SendFailure(
      "rate_limited",
      "rate_limited",
      Number.isFinite(seconds) && seconds > 0
        ? Math.min(seconds * 1000, 3600000)
        : 1000,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SendFailure(
      response.status >= 500 ? "unknown" : "rejected",
      `http_${response.status}`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SendFailure("unknown", "empty_response");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 1024 * 1024) {
        await reader.cancel();
        throw new SendFailure("unknown", "response_too_large");
      }
      parts.push(part.value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (e) {
    if (e instanceof SendFailure) throw e;
    throw new SendFailure("unknown", "invalid_response");
  } finally {
    reader.releaseLock();
  }
}
