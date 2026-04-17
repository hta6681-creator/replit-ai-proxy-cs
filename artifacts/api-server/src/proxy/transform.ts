import { convertImageForAnthropic } from "./images.js";
import type { ModelEntry } from "./models.js";

export interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  [key: string]: unknown;
}

export function extractSystemMessages(messages: OpenAIMessage[]): {
  system: string | null;
  conversation: OpenAIMessage[];
} {
  const systemParts: string[] = [];
  const conversation: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b) => b.type === "text")
                .map((b) => (b as any).text)
                .join("")
            : "";
      if (text) systemParts.push(text);
    } else {
      conversation.push(msg);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : null,
    conversation,
  };
}

async function buildAnthropicContent(
  content: Array<{ type: string; [key: string]: unknown }>,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      result.push({ type: "text", text: (part as any).text });
    } else if (part.type === "image_url") {
      const source = await convertImageForAnthropic(
        (part as any).image_url.url,
      );
      result.push({ type: "image", source });
    }
  }
  return result;
}

export async function convertToAnthropicMessages(
  conversation: OpenAIMessage[],
): Promise<Array<{ role: string; content: unknown }>> {
  const result: Array<{ role: string; content: unknown }> = [];

  for (const msg of conversation) {
    if (msg.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      });
    } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      const text =
        typeof msg.content === "string" ? msg.content : "";
      if (text) {
        blocks.push({ type: "text", text });
      }
      for (const tc of msg.tool_calls) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      result.push({ role: "assistant", content: blocks });
    } else if (typeof msg.content === "string") {
      result.push({
        role: msg.role,
        content: [{ type: "text", text: msg.content }],
      });
    } else if (Array.isArray(msg.content)) {
      const anthropicContent = await buildAnthropicContent(msg.content);
      result.push({ role: msg.role, content: anthropicContent });
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  return result;
}

export function convertToolsToAnthropic(
  tools: Array<{
    type: string;
    function: {
      name: string;
      description?: string;
      parameters?: unknown;
    };
  }>,
): Array<{ name: string; description?: string; input_schema: unknown }> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters || { type: "object", properties: {} },
  }));
}

export function convertToolChoiceToAnthropic(
  choice: unknown,
): { type: string; name?: string } | null {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return null; // signal: strip tools
  if (typeof choice === "object" && choice !== null) {
    const c = choice as any;
    if (c.type === "function" && c.function?.name) {
      return { type: "tool", name: c.function.name };
    }
  }
  return { type: "auto" };
}

export function convertToolUseToOpenAI(
  blocks: Array<{ type: string; id: string; name: string; input: unknown }>,
): Array<{
  id: string;
  type: string;
  index: number;
  function: { name: string; arguments: string };
}> {
  let counter = 0;
  return blocks.map((block) => ({
    id: block.id,
    type: "function",
    index: counter++,
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input),
    },
  }));
}

export function buildSSEChunk(
  id: string,
  model: string,
  choices: Array<Record<string, unknown>>,
  created: number,
  usage?: Record<string, unknown>,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices,
    ...(usage ? { usage } : {}),
  });
}
