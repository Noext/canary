export async function fetchText(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
  maxBytes = 5_000_000
): Promise<{ response: Response; text: string }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  }
  if (!response.body) {
    throw new Error("Empty HTTP response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error(`HTTP response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return { response, text: Buffer.concat(chunks).toString("utf8") };
}
