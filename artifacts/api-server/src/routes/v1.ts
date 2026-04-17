import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { MODEL_REGISTRY, getModelList } from "../proxy/models.js";
import { handleOpenAI } from "../proxy/openai.js";
import { handleAnthropic, handleAnthropicNative } from "../proxy/anthropic.js";
import { openrouter as openrouterClient, codebuffAuth } from "../proxy/clients.js";
import { codebuffChatCompletions, finishCodebuffRun } from "../proxy/codebuff.js";
import {
  sendError,
  sendAnthropicError,
  parseUpstreamError,
} from "../proxy/errors.js";
import { getStats } from "../proxy/stats.js";

const router = Router();

const PROXY_KEY = process.env.PROXY_API_KEY;

function makeAuth(errorFormat: "openai" | "anthropic") {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!PROXY_KEY) {
      if (errorFormat === "anthropic") {
        sendAnthropicError(res, 500, "PROXY_API_KEY not configured");
      } else {
        sendError(res, 500, "PROXY_API_KEY not configured");
      }
      return;
    }

    const bearer = req.headers.authorization?.replace(/^Bearer /i, "");
    const xApiKey = req.headers["x-api-key"] as string | undefined;
    const token = bearer || xApiKey;

    if (token !== PROXY_KEY) {
      if (errorFormat === "anthropic") {
        sendAnthropicError(res, 401, "Invalid API key", "authentication_error");
      } else {
        sendError(res, 401, "Invalid API key", "invalid_request_error", "invalid_api_key");
      }
      return;
    }
    next();
  };
}

const authOpenAI = makeAuth("openai");
const authAnthropic = makeAuth("anthropic");

router.get("/models", authOpenAI, (_req: Request, res: Response) => {
  res.json(getModelList());
});

router.get("/stats", authOpenAI, (_req: Request, res: Response) => {
  res.json(getStats());
});

router.post(
  "/chat/completions",
  authOpenAI,
  async (req: Request, res: Response) => {
    const body = req.body;

    if (!body.model) {
      return sendError(
        res,
        400,
        "model is required",
        "invalid_request_error",
        "missing_parameter",
      );
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendError(res, 400, "messages must be a non-empty array");
    }

    const entry = MODEL_REGISTRY[body.model];
    if (!entry) {
      return sendError(
        res,
        400,
        `Model '${body.model}' not found. Supported: ${Object.keys(MODEL_REGISTRY).join(", ")}`,
        "invalid_request_error",
        "model_not_found",
      );
    }

    const proxyModelId = body.model;

    if (body.max_token !== undefined && body.max_tokens === undefined) {
      body.max_tokens = body.max_token;
      delete body.max_token;
    }

    try {
      if (codebuffAuth) {
        const upstream = await codebuffChatCompletions(body, codebuffAuth) as any;
        const runId = upstream.__runId;

        if (body.stream === true) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders();
          try {
            const reader = upstream.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(decoder.decode(value, { stream: true }));
            }
          } catch {} finally {
            res.end();
            await finishCodebuffRun(runId, codebuffAuth);
          }
        } else {
          const data = await upstream.text();
          await finishCodebuffRun(runId, codebuffAuth);
          res.setHeader("Content-Type", "application/json");
          res.end(data);
        }
        return;
      }

      if (entry.provider === "openrouter") {
        if (!openrouterClient) {
          return sendError(res, 500, "OpenRouter integration not configured");
        }
        await handleOpenAI(req, res, entry, proxyModelId, body, openrouterClient);
      } else if (entry.provider === "openai") {
        await handleOpenAI(req, res, entry, proxyModelId, body);
      } else {
        await handleAnthropic(req, res, entry, proxyModelId, body);
      }
    } catch (err: any) {
      const parsed = parseUpstreamError(err);
      if (!res.headersSent) {
        sendError(res, parsed.status, parsed.message, "api_error", parsed.code);
      }
    }
  },
);

router.post("/messages", authAnthropic, async (req: Request, res: Response) => {
  const body = req.body;

  if (!body.model) {
    return sendAnthropicError(res, 400, "model is required");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendAnthropicError(res, 400, "messages is required");
  }

  const entry = MODEL_REGISTRY[body.model];
  if (!entry || entry.provider !== "anthropic") {
    return sendAnthropicError(
      res,
      400,
      "Only Claude models are supported on /v1/messages. Use /v1/chat/completions for OpenAI models.",
    );
  }

  const proxyModelId = body.model;
  const bodyCopy = structuredClone(body);

  try {
    await handleAnthropicNative(req, res, entry, proxyModelId, bodyCopy);
  } catch (err: any) {
    const parsed = parseUpstreamError(err);
    if (!res.headersSent) {
      sendAnthropicError(res, parsed.status, parsed.message);
    }
  }
});

router.post("/responses", authOpenAI, (_req: Request, res: Response) => {
  sendError(
    res,
    404,
    "/v1/responses is not supported. Use /v1/chat/completions.",
  );
});

export default router;
