import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { anthropic } from "./clients.js";
import type { ModelEntry } from "./models.js";
import { resolveThinking, resolveNativeThinking } from "./models.js";
import {
  withRateLimit,
  acquireSlot,
  releaseSlot,
  retryDelay,
  MAX_RETRIES,
} from "./ratelimit.js";
import { recordRequest } from "./stats.js";
import {
  sendError,
  sendStreamError,
  sendAnthropicError,
  sendAnthropicStreamError,
  parseUpstreamError,
} from "./errors.js";
import {
  extractSystemMessages,
  convertToAnthropicMessages,
  convertToolsToAnthropic,
  convertToolChoiceToAnthropic,
  convertToolUseToOpenAI,
  buildSSEChunk,
} from "./transform.js";
import type { OpenAIMessage } from "./transform.js";
import { convertAnthropicNativeImages } from "./images.js";
import { startSSE, writeSSE, startKeepalive, endSSE } from "./sse.js";

function randomId(): string {
  return "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
}

function finishReason(r: string | null | undefined): string {
  if (r === "end_turn") return "stop";
  if (r === "max_tokens") return "length";
  if (r === "tool_use") return "tool_calls";
  return "stop";
}

function stripCacheControl(cc: unknown): void {
  if (cc && typeof cc === "object") delete (cc as any).scope;
}

function stripBlocksCacheControl(blocks: unknown): void {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    stripCacheControl((b as any).cache_control);
    if (Array.isArray((b as any).content))
      stripBlocksCacheControl((b as any).content);
  }
}

export function stripCacheControlScope(
  body: Record<string, unknown>,
): void {
  if (Array.isArray(body.system)) stripBlocksCacheControl(body.system);
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages as any[]) {
      if (Array.isArray(msg.content)) stripBlocksCacheControl(msg.content);
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools as any[]) {
      stripCacheControl(tool.cache_control);
    }
  }
}

async function buildAnthropicParams(
  modelEntry: ModelEntry,
  body: Record<string, unknown>,
): Promise<{ params: any; sdkOpts: any }> {
  const { system, conversation } = extractSystemMessages(
    body.messages as OpenAIMessage[],
  );
  const anthropicMessages = await convertToAnthropicMessages(conversation);
  const { thinkingEnabled, budgetTokens, maxTokens } = resolveThinking(
    modelEntry,
    body,
  );

  const params: any = {
    model: modelEntry.upstream,
    messages: anthropicMessages,
    max_tokens: maxTokens || (body.max_tokens as number) || 4096,
  };

  if (system) params.system = system;
  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;

  if (body.stop !== undefined) {
    params.stop_sequences = Array.isArray(body.stop)
      ? body.stop
      : [body.stop];
  }

  if (body.tools) {
    const anthropicTools = convertToolsToAnthropic(body.tools as any);
    const toolChoice = body.tool_choice
      ? convertToolChoiceToAnthropic(body.tool_choice)
      : undefined;

    if (toolChoice === null) {
      // "none" → strip tools
    } else {
      params.tools = anthropicTools;
      if (toolChoice) params.tool_choice = toolChoice;
    }
  }

  if (thinkingEnabled) {
    params.thinking = { type: "enabled", budget_tokens: budgetTokens };
    delete params.temperature;
    delete params.top_p;
  }

  (params as any).metadata = { user_id: "free-tier" };

  const sdkOpts: any = {};
  if (thinkingEnabled) sdkOpts.timeout = 300000;

  return { params, sdkOpts };
}

async function handleAnthropicNonStream(
  res: Response,
  params: any,
  proxyModelId: string,
  sdkOpts: any,
  controller: AbortController,
  startTime: number,
): Promise<void> {
  let isError = false;
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

  try {
    const response: any = await withRateLimit(() =>
      (anthropic.messages.create as Function)(
        { ...params, stream: false },
        { ...sdkOpts, signal: controller.signal },
      ),
    );

    let textContent = "";
    let reasoningContent = "";
    const toolCalls: Array<{
      type: string;
      id: string;
      name: string;
      input: unknown;
    }> = [];

    for (const block of response.content) {
      if (block.type === "text") textContent += block.text;
      else if (block.type === "thinking") reasoningContent += block.thinking;
      else if (block.type === "tool_use") toolCalls.push(block);
    }

    const message: any = {
      role: "assistant",
      content: textContent || null,
    };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) {
      message.tool_calls = convertToolUseToOpenAI(toolCalls as any);
    }

    usage = {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
    };

    res.json({
      id: randomId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: proxyModelId,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason(response.stop_reason),
        },
      ],
      usage: {
        ...usage,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
    });
  } catch (err: any) {
    isError = true;
    const parsed = parseUpstreamError(err);
    sendError(res, parsed.status, parsed.message, "api_error", parsed.code);
  } finally {
    recordRequest("anthropic", {
      error: isError,
      ...(usage ? { usage } : {}),
      durationMs: Date.now() - startTime,
    });
  }
}

async function handleAnthropicStream(
  res: Response,
  params: any,
  proxyModelId: string,
  sdkOpts: any,
  controller: AbortController,
  startTime: number,
): Promise<void> {
  await acquireSlot();
  let isError = false;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCallIndex = 0;
  let ttftRecorded = false;
  let ttftMs = 0;

  try {
    let streamObj: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        streamObj = (anthropic.messages.stream as Function)(
          { ...params },
          { ...sdkOpts, signal: controller.signal },
        );
        break;
      } catch (err: any) {
        if (err.status !== 429 || attempt === MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      }
    }

    startSSE(res);
    keepalive = startKeepalive(res);

    const streamId = randomId();
    const created = Math.floor(Date.now() / 1000);

    for await (const event of streamObj) {
      if (event.type === "message_start") {
        inputTokens = event.message?.usage?.input_tokens ?? 0;
      } else if (
        event.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      ) {
        const chunk = buildSSEChunk(streamId, proxyModelId, [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: toolCallIndex++,
                  id: event.content_block.id,
                  type: "function",
                  function: {
                    name: event.content_block.name,
                    arguments: "",
                  },
                },
              ],
            },
          },
        ], created);
        writeSSE(res, `data: ${chunk}\n\n`);
      } else if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta") {
          const chunk = buildSSEChunk(streamId, proxyModelId, [
            { index: 0, delta: { content: event.delta.text } },
          ], created);
          writeSSE(res, `data: ${chunk}\n\n`);
          if (!ttftRecorded) {
            ttftMs = Date.now() - startTime;
            ttftRecorded = true;
          }
        } else if (event.delta?.type === "thinking_delta") {
          const chunk = buildSSEChunk(streamId, proxyModelId, [
            { index: 0, delta: { reasoning_content: event.delta.thinking } },
          ], created);
          writeSSE(res, `data: ${chunk}\n\n`);
        } else if (event.delta?.type === "input_json_delta") {
          const chunk = buildSSEChunk(streamId, proxyModelId, [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolCallIndex - 1,
                    function: { arguments: event.delta.partial_json },
                  },
                ],
              },
            },
          ], created);
          writeSSE(res, `data: ${chunk}\n\n`);
        }
      } else if (event.type === "message_delta") {
        outputTokens = event.usage?.output_tokens ?? outputTokens;
        const chunk = buildSSEChunk(
          streamId,
          proxyModelId,
          [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason(event.delta?.stop_reason),
            },
          ],
          created,
          {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        );
        writeSSE(res, `data: ${chunk}\n\n`);
      }
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
    recordRequest("anthropic", {
      error: isError,
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      durationMs: Date.now() - startTime,
      ttftMs: ttftRecorded ? ttftMs : undefined,
    });
  }
}

export async function handleAnthropic(
  req: Request,
  res: Response,
  modelEntry: ModelEntry,
  proxyModelId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const startTime = Date.now();
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  if (body.n && (body.n as number) > 1) {
    sendError(
      res,
      400,
      "Anthropic does not support n > 1",
      "invalid_request_error",
      "unsupported_parameter",
    );
    return;
  }

  const { params, sdkOpts } = await buildAnthropicParams(modelEntry, body);

  if (body.stream === true) {
    return handleAnthropicStream(res, params, proxyModelId, sdkOpts, controller, startTime);
  }
  return handleAnthropicNonStream(res, params, proxyModelId, sdkOpts, controller, startTime);
}

async function handleNativeNonStream(
  req: Request,
  res: Response,
  body: Record<string, unknown>,
  upstreamUrl: string,
  headers: Record<string, string>,
  controller: AbortController,
  startTime: number,
): Promise<void> {
  let isError = false;
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

  try {
    const upstream = await withRateLimit(async () => {
      const resp = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (resp.status === 429) {
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      }
      return resp;
    });

    if (!upstream.ok) {
      isError = true;
      const text = await upstream.text();
      let msg = text;
      try {
        msg = JSON.parse(text).error?.message ?? text;
      } catch {}
      sendAnthropicError(res, upstream.status, msg);
    } else {
      const data = (await upstream.json()) as any;
      usage = {
        prompt_tokens: data.usage?.input_tokens ?? 0,
        completion_tokens: data.usage?.output_tokens ?? 0,
      };
      res.json(data);
    }
  } catch (err: any) {
    isError = true;
    const parsed = parseUpstreamError(err);
    if (!res.headersSent)
      sendAnthropicError(res, parsed.status, parsed.message);
  } finally {
    recordRequest("anthropic", {
      error: isError,
      ...(usage ? { usage } : {}),
      durationMs: Date.now() - startTime,
    });
  }
}

async function handleNativeStream(
  res: Response,
  body: Record<string, unknown>,
  upstreamUrl: string,
  headers: Record<string, string>,
  controller: AbortController,
  startTime: number,
): Promise<void> {
  await acquireSlot();
  let isError = false;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let ttftRecorded = false;
  let ttftMs = 0;

  const bodyStr = JSON.stringify(body);

  try {
    let upstream!: globalThis.Response;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      if (upstream.status !== 429) break;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      }
    }

    if (!upstream.ok) {
      isError = true;
      const text = await upstream.text();
      let msg = text;
      try {
        msg = JSON.parse(text).error?.message ?? text;
      } catch {}
      sendAnthropicError(res, upstream.status, msg);
      return;
    }

    startSSE(res);
    keepalive = startKeepalive(res);

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";

      for (const evt of events) {
        if (!evt.trim()) continue;
        writeSSE(res, evt + "\n\n");

        const dataLine = evt
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (dataLine) {
          try {
            const d = JSON.parse(dataLine.slice(6));
            if (d.type === "message_start") {
              inputTokens = d.message?.usage?.input_tokens ?? 0;
            } else if (
              d.type === "content_block_delta" &&
              !ttftRecorded
            ) {
              ttftMs = Date.now() - startTime;
              ttftRecorded = true;
            } else if (d.type === "message_delta" && d.usage) {
              outputTokens = d.usage.output_tokens;
            }
          } catch {}
        }
      }
    }

    if (buf.trim()) writeSSE(res, buf + "\n\n");
  } catch (err: any) {
    isError = true;
    if (res.headersSent) {
      sendAnthropicStreamError(res, err.message || "Stream error");
    } else {
      sendAnthropicError(res, 502, err.message || "Stream error");
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
    controller.abort();
    releaseSlot();
    endSSE(res);
    recordRequest("anthropic", {
      error: isError,
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      durationMs: Date.now() - startTime,
      ttftMs: ttftRecorded ? ttftMs : undefined,
    });
  }
}

export async function handleAnthropicNative(
  req: Request,
  res: Response,
  modelEntry: ModelEntry,
  _proxyModelId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const startTime = Date.now();
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  body.model = modelEntry.upstream;
  resolveNativeThinking(modelEntry, body);

  const thinkingEnabled =
    body.thinking &&
    typeof body.thinking === "object" &&
    (body.thinking as any).type === "enabled";
  if (!body.max_tokens && !thinkingEnabled) body.max_tokens = 4096;

  if (thinkingEnabled) {
    delete body.temperature;
    delete body.top_p;
  } else if (body.temperature !== undefined && body.top_p !== undefined) {
    delete body.top_p;
  }

  await convertAnthropicNativeImages(body.messages as any);
  delete body.thinking_budget;
  delete body.context_management;
  stripCacheControlScope(body);

  (body as any).replit_metadata = { cost_mode: "free", billing: "skip" };
  (body as any).metadata = { user_id: "free-tier", billing_mode: "none" };

  const upstreamUrl = `${process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL}/v1/messages`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY!,
    "anthropic-version":
      (req.headers["anthropic-version"] as string) || "2023-06-01",
  };
  if (req.headers["anthropic-beta"]) {
    headers["anthropic-beta"] = req.headers["anthropic-beta"] as string;
  }

  if (body.stream === true) {
    return handleNativeStream(res, body, upstreamUrl, headers, controller, startTime);
  }
  return handleNativeNonStream(req, res, body, upstreamUrl, headers, controller, startTime);
}
