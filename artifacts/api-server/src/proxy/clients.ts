import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const requiredVars = [
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
  "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
] as const;

for (const v of requiredVars) {
  if (!process.env[v]) throw new Error(`Missing required env var: ${v}`);
}

export const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

export const anthropic = new Anthropic({
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
});

export const openrouter: OpenAI | null =
  process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL &&
  process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY
    ? new OpenAI({
        baseURL: process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL,
        apiKey: process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY,
      })
    : null;

export const codebuffAuth: string | null = process.env.CODEBUFF_AUTH || null;
