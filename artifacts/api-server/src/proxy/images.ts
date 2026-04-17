const MIME_WHITELIST = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

export async function convertImageForAnthropic(
  url: string,
): Promise<{ type: "base64"; media_type: string; data: string }> {
  // data: URL
  const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataMatch) {
    return {
      type: "base64",
      media_type: dataMatch[1],
      data: dataMatch[2],
    };
  }

  // Remote URL — validate before fetching
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid image URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported image URL protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("169.254.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error(`Image URL points to a private/internal address: ${host}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(url, { signal: controller.signal, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(`Image URL redirected (blocked for security): ${resp.status}`);
    }
    if (!resp.ok) {
      throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText}`);
    }

    const contentLength = resp.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_SIZE) {
      throw new Error(`Image too large: ${contentLength} bytes (max ${MAX_SIZE})`);
    }

    const contentType = resp.headers.get("content-type") || "image/jpeg";
    const mediaType = contentType.split(";")[0].trim();
    if (!MIME_WHITELIST.has(mediaType)) {
      throw new Error(`Unsupported image type: ${mediaType}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > MAX_SIZE) {
      throw new Error(`Image too large: ${buffer.length} bytes (max ${MAX_SIZE})`);
    }

    return {
      type: "base64",
      media_type: mediaType,
      data: buffer.toString("base64"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function convertAnthropicNativeImages(
  messages: Array<{ role: string; content: unknown }>,
): Promise<void> {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as any).type === "image" &&
        (block as any).source?.type === "url"
      ) {
        const result = await convertImageForAnthropic(
          (block as any).source.url,
        );
        (block as any).source = result;
      }
    }
  }
}
