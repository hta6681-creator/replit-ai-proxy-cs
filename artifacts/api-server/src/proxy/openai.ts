import type { Request, Response } from "express";
import { openai as defaultClient } from "./clients.js";
import type OpenAI from "openai";
import type { ModelEntry } from "./models.js";
import { withRateLimit, acquireSlot, releaseSlot, retryDelay, MAX_RETRIES } from "./ratelimit.js";
import { recordRequest } from "./stats.js";
import { sendError, sendStreamError, parseUpstreamError } from "./errors.js";
import { startSSE, writeSSE, startKeepalive, endSSE } from "./sse.js";

function cleanAzure(obj: any, proxyModelId: string): void {
  delete obj.prompt_filter_results;
  delete obj.obfuscation;
  if (obj.choices) {
    for (const c of obj.choices) {
      delete c.content_filter_results;
      if (c.message) delete c.message.annotations;
      if (c.delta) delete c.delta.annotations;
    }
  }
  obj.model = proxyModelId;
}

function buildParams(modelEntry: ModelEntry, body: Record<string, unknown>): any {
  const params: any = {
    model: modelEntry.upstream,
    messages: body.messages,
  };

  if (modelEntry.paramStyle === "gpt5") {
    params.max_completion_tokens = (body.max_tokens as number) || 8192;
  } else if (modelEntry.paramStyle === "reasoning") {
    params.max_completion_tokens = (body.max_tokens as number) || 8192;
  } else {
    if (body.temperature !== undefined) params.temperature = body.temperature;
    if (body.top_p !== undefined) params.top_p = body.top_p;
    if (body.frequency_penalty !== undefined) params.frequency_penalty = body.frequency_penalty;
    if (body.presence_penalty !== undefined) params.presence_penalty = body.presence_penalty;
    if (body.max_tokens !== undefined) params.max_tokens = body.max_tokens;
  }

  if (body.stop !== undefined) params.stop = body.stop;
  if (body.user !== undefined) params.user = body.user;
  if (body.n !== undefined) params.n = body.n;
  if (body.tools) params.tools = body.tools;
  if (body.tool_choice) params.tool_choice = body.tool_choice;

  return params;
}

async function handleNonStream(
  res: Response,
  params: any,
  proxyModelId: string,
  controller: AbortController,
  startTime: number,
  client: OpenAI,
  statsProvider: "openai" | "anthropic" | "openrouter",
): Promise<void> {
  let isError = false;
  let usage: any;
  try {
    const completion = await withRateLimit(() =>
      client.chat.completions.create(params as any, {
        signal: controller.signal,
      }),
    );
    cleanAzure(completion, proxyModelId);
    usage = completion.usage;
    res.json(completion);
  } catch (err: any) {
    isError = true;
    const parsed = parseUpstreamError(err);
    sendError(res, parsed.status, parsed.message, "api_error", parsed.code);
  } finally {
    recordRequest(statsProvider, {
      error: isError,
      ...(usage ? { usage } : {}),
      durationMs: Date.now() - startTime,
    });
  }
}

async function handleStream(
  res: Response,
  params: any,
  body: Record<string, unknown>,
  proxyModelId: string,
  controller: AbortController,
  startTime: number,
  client: OpenAI,
  statsProvider: "openai" | "anthropic" | "openrouter",
): Promise<void> {
  await acquireSlot();
  let isError = false;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let ttftMs = 0;
  let ttftRecorded = false;
  let streamUsage: any;

  try {
    params.stream = true;
    params.stream_options = {
      ...((body.stream_options as any) || {}),
      include_usage: false,
    };

    let stream: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        stream = await client.chat.completions.create(params as any, {
          signal: controller.signal,
        });
        break;
      } catch (err: any) {
        if (err.status !== 429 || attempt === MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      }
    }

    startSSE(res);
    keepalive = startKeepalive(res);

    for await (const chunk of stream as any) {
      if (
        Array.isArray(chunk.choices) &&
        chunk.choices.length === 0 &&
        (chunk.id === "" || !chunk.usage)
      )
        continue;

      cleanAzure(chunk, proxyModelId);

      writeSSE(res, `data: ${JSON.stringify(chunk)}\n\n`);
      if (typeof (res as any).flush === "function") (res as any).flush();

      if (!ttftRecorded && chunk.choices?.[0]?.delta?.content) {
        ttftMs = Date.now() - startTime;
        ttftRecorded = true;
      }

      if (chunk.choices?.[0]?.finish_reason) {
        controller.abort();
        break;
      }

      if (chunk.usage) streamUsage = chunk.usage;
    }

    writeSSE(res, "data: [DONE]\n\n");
  } catch (err: any) {
    isError = true;
    const parsed = parseUpstreamError(err);
    if (res.headersSent) {
      sendStreamError(res, parsed.message);
    } else {
      sendError(res, parsed.status, parsed.message, "api_error", parsed.code);
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
    controller.abort();
    releaseSlot();
    endSSE(res);
    recordRequest(statsProvider, {
      error: isError,
      ...(streamUsage
        ? {
            usage: {
              prompt_tokens: streamUsage.prompt_tokens,
              completion_tokens: streamUsage.completion_tokens,
            },
          }
        : {}),
      durationMs: Date.now() - startTime,
      ttftMs: ttftRecorded ? ttftMs : undefined,
    });
  }
}

export async function handleOpenAI(
  req: Request,
  res: Response,
  modelEntry: ModelEntry,
  proxyModelId: string,
  body: Record<string, unknown>,
  client?: OpenAI,
): Promise<void> {
  const startTime = Date.now();
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const c = client ?? defaultClient;
  const statsProvider = client ? (modelEntry.provider as "openai" | "anthropic" | "openrouter") : "openai";
  const params = buildParams(modelEntry, body);

  if (body.stream === true) {
    return handleStream(res, params, body, proxyModelId, controller, startTime, c, statsProvider);
  }
  return handleNonStream(res, params, proxyModelId, controller, startTime, c, statsProvider);
}
