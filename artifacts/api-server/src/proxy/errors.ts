import type { Request, Response, NextFunction } from "express";

// OpenAI JSON format (/v1/chat/completions, /v1/models, /v1/stats)
export function sendError(
  res: Response,
  status: number,
  message: string,
  type?: string,
  code?: string | null,
): void {
  if (res.headersSent) return;
  res.status(status).json({
    error: {
      message,
      type: type || "invalid_request_error",
      code: code || null,
    },
  });
}

// Anthropic JSON format (/v1/messages)
export function sendAnthropicError(
  res: Response,
  status: number,
  message: string,
  errType?: string,
): void {
  if (res.headersSent) return;
  res.status(status).json({
    type: "error",
    error: {
      type: errType || "invalid_request_error",
      message,
    },
  });
}

// OpenAI SSE stream error
export function sendStreamError(res: Response, message: string): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// Anthropic SSE stream error
export function sendAnthropicStreamError(
  res: Response,
  message: string,
): void {
  if (res.writableEnded) return;
  res.write(
    `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`,
  );
  res.end();
}

export function parseUpstreamError(
  error: any,
): { status: number; message: string; code: string } {
  const status = error.status || error.statusCode;
  const msg =
    error.error?.error?.message ||
    error.error?.message ||
    error.message ||
    "Unknown upstream error";

  // 404 + DeploymentNotFound
  if (status === 404 && msg.includes("DeploymentNotFound")) {
    return { status: 400, message: msg, code: "model_not_found" };
  }
  // 400 + UNSUPPORTED_MODEL
  if (status === 400 && msg.includes("UNSUPPORTED_MODEL")) {
    return { status: 400, message: msg, code: "model_not_found" };
  }
  // 429
  if (status === 429) {
    return { status: 429, message: msg, code: "rate_limit_exceeded" };
  }
  // 500/502/503
  if (status === 500 || status === 502 || status === 503) {
    return { status: 502, message: msg, code: "upstream_error" };
  }
  // Connection errors
  if (
    error.code === "ECONNREFUSED" ||
    error.code === "ETIMEDOUT" ||
    error.name === "AbortError" ||
    error.type === "aborted"
  ) {
    return { status: 504, message: msg, code: "upstream_timeout" };
  }
  // Default
  return { status: status || 500, message: msg, code: "upstream_error" };
}

export function jsonErrorMiddleware(
  err: Error & { status?: number; statusCode?: number; type?: string },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  if (err instanceof SyntaxError && status === 400) {
    sendError(res, 400, "Invalid JSON in request body");
    return;
  }
  if (err.type === "entity.too.large" || status === 413) {
    sendError(res, 413, "Request body too large");
    return;
  }
  sendError(res, status, err.message || "Internal server error", "api_error");
}
