import { getQueueInfo } from "./ratelimit.js";

interface ProviderStats {
  totalCalls: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  totalDurationMs: number;
  callCountForDuration: number;
  totalTtftMs: number;
  streamCallCount: number;
}

const startTime = Date.now();

function emptyStats(): ProviderStats {
  return {
    totalCalls: 0,
    errorCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalDurationMs: 0,
    callCountForDuration: 0,
    totalTtftMs: 0,
    streamCallCount: 0,
  };
}

const providers: Record<"openai" | "anthropic" | "openrouter", ProviderStats> = {
  openai: emptyStats(),
  anthropic: emptyStats(),
  openrouter: emptyStats(),
};

export function recordRequest(
  provider: "openai" | "anthropic" | "openrouter",
  opts: {
    usage?: { prompt_tokens: number; completion_tokens: number };
    durationMs: number;
    ttftMs?: number;
    error?: boolean;
  },
): void {
  const s = providers[provider];
  s.totalCalls++;

  if (opts.error) {
    s.errorCount++;
  }

  if (opts.usage) {
    s.promptTokens += opts.usage.prompt_tokens;
    s.completionTokens += opts.usage.completion_tokens;
  }

  s.totalDurationMs += opts.durationMs;
  s.callCountForDuration++;

  if (opts.ttftMs !== undefined) {
    s.totalTtftMs += opts.ttftMs;
    s.streamCallCount++;
  }
}

export function getStats(): object {
  const uptimeMs = Date.now() - startTime;

  function formatProvider(s: ProviderStats) {
    return {
      totalCalls: s.totalCalls,
      errorCount: s.errorCount,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      avgDurationMs: s.callCountForDuration > 0
        ? Math.round(s.totalDurationMs / s.callCountForDuration)
        : 0,
      avgTtftMs: s.streamCallCount > 0
        ? Math.round(s.totalTtftMs / s.streamCallCount)
        : 0,
    };
  }

  return {
    uptime: `${Math.floor(uptimeMs / 1000)}s`,
    rateLimit: getQueueInfo(),
    providers: {
      openai: formatProvider(providers.openai),
      anthropic: formatProvider(providers.anthropic),
      openrouter: formatProvider(providers.openrouter),
    },
  };
}
