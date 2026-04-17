export interface ModelEntry {
  provider: "openai" | "anthropic" | "openrouter";
  upstream: string;
  thinkingCapable: boolean;
  modelCap?: number;
  thinkingTier?: "standard" | "max";
  paramStyle?: "gpt5" | "reasoning" | "standard";
  ownedBy: string;
  created: number;
}

function claudeThinkingVariants(
  baseId: string,
  upstream: string,
  modelCap: number,
): Record<string, ModelEntry> {
  const base: ModelEntry = {
    provider: "anthropic",
    upstream,
    thinkingCapable: true,
    modelCap,
    ownedBy: "anthropic",
    created: 1700000000,
  };
  return {
    [baseId]: base,
    [`${baseId}-thinking`]: { ...base, thinkingTier: "standard" },
    [`${baseId}-thinking-max`]: { ...base, thinkingTier: "max" },
  };
}

export const MODEL_REGISTRY: Record<string, ModelEntry> = {
  "gpt-5.4": {
    provider: "openai",
    upstream: "gpt-5.4",
    thinkingCapable: false,
    paramStyle: "gpt5",
    ownedBy: "openai",
    created: 1700000000,
  },
  "gpt-5.2": {
    provider: "openai",
    upstream: "gpt-5.2",
    thinkingCapable: false,
    paramStyle: "gpt5",
    ownedBy: "openai",
    created: 1700000000,
  },
  "gpt-5-mini": {
    provider: "openai",
    upstream: "gpt-5-mini",
    thinkingCapable: false,
    paramStyle: "gpt5",
    ownedBy: "openai",
    created: 1700000000,
  },
  "o4-mini": {
    provider: "openai",
    upstream: "o4-mini",
    thinkingCapable: false,
    paramStyle: "reasoning",
    ownedBy: "openai",
    created: 1700000000,
  },
  "o3": {
    provider: "openai",
    upstream: "o3",
    thinkingCapable: false,
    paramStyle: "reasoning",
    ownedBy: "openai",
    created: 1700000000,
  },
  ...claudeThinkingVariants("claude-opus-4-6", "claude-opus-4-6", 128000),
  ...claudeThinkingVariants("claude-opus-4-5", "claude-opus-4-5", 64000),
  "claude-sonnet-4-6": {
    provider: "anthropic",
    upstream: "claude-sonnet-4-6",
    thinkingCapable: false,
    modelCap: 64000,
    ownedBy: "anthropic",
    created: 1700000000,
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    upstream: "claude-haiku-4-5",
    thinkingCapable: false,
    modelCap: 64000,
    ownedBy: "anthropic",
    created: 1700000000,
  },
  "claude-opus-4-6-fast": {
    provider: "openrouter",
    upstream: "anthropic/claude-4.6-opus-fast-20260407",
    thinkingCapable: false,
    modelCap: 128000,
    ownedBy: "anthropic",
    created: 1700000000,
  },
};

export function clampToModelCap(
  budget: number,
  max: number,
  modelCap?: number,
): { budgetTokens: number; maxTokens: number } {
  if (modelCap && max > modelCap) max = modelCap;
  if (budget >= max) budget = max - 1;
  return { budgetTokens: budget, maxTokens: max };
}

export function resolveThinking(
  entry: ModelEntry,
  body: Record<string, unknown>,
): { thinkingEnabled: boolean; budgetTokens: number; maxTokens: number } {
  let enabled = !!entry.thinkingTier || body.thinking === true;

  if (enabled && !entry.thinkingCapable) {
    enabled = false;
  }

  let budgetTokens: number;
  let maxTokens: number;

  if (entry.thinkingTier === "max") {
    maxTokens = entry.modelCap ?? 64000;
    budgetTokens = Math.floor(maxTokens * 25 / 32);
  } else {
    budgetTokens = 10000;
    maxTokens = 16000;
  }

  if (!enabled) {
    return { thinkingEnabled: false, budgetTokens: 0, maxTokens: (body.max_tokens as number) || 4096 };
  }

  if (typeof body.thinking_budget === "number") {
    budgetTokens = body.thinking_budget;
  }

  if (typeof body.max_tokens === "number") {
    maxTokens = body.max_tokens;
  }

  if (maxTokens <= budgetTokens) {
    maxTokens = budgetTokens + 4096;
  }

  const clamped = clampToModelCap(budgetTokens, maxTokens, entry.modelCap);

  return { thinkingEnabled: enabled, budgetTokens: clamped.budgetTokens, maxTokens: clamped.maxTokens };
}

export function resolveNativeThinking(
  entry: ModelEntry,
  body: Record<string, unknown>,
): void {
  const thinking = body.thinking as any;

  if (thinking && typeof thinking === "object" && thinking.type === "enabled") {
    if (entry.modelCap && typeof thinking.budget_tokens === "number") {
      let maxTokens = (body.max_tokens as number) || entry.modelCap;
      const clamped = clampToModelCap(thinking.budget_tokens, maxTokens, entry.modelCap);
      body.max_tokens = clamped.maxTokens;
      thinking.budget_tokens = clamped.budgetTokens;
    }
    delete body.thinking_budget;
    return;
  }

  const { thinkingEnabled, budgetTokens, maxTokens } = resolveThinking(entry, body);

  if (thinkingEnabled) {
    body.thinking = { type: "enabled", budget_tokens: budgetTokens };
    body.max_tokens = maxTokens;
  } else {
    delete body.thinking;
  }

  delete body.thinking_budget;
}

export function getModelList(): {
  object: string;
  data: Array<{ id: string; object: string; created: number; owned_by: string }>;
} {
  return {
    object: "list",
    data: Object.entries(MODEL_REGISTRY).map(([id, entry]) => ({
      id,
      object: "model",
      created: entry.created,
      owned_by: entry.ownedBy,
    })),
  };
}
