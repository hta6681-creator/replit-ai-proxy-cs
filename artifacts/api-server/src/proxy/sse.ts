import type { Response } from "express";

export function startSSE(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

export function writeSSE(res: Response, data: string): void {
  if (!res.writableEnded) res.write(data);
}

export function startKeepalive(res: Response, intervalMs = 5000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, intervalMs);
}

export function endSSE(res: Response): void {
  if (!res.writableEnded) res.end();
}
