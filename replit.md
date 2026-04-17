# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## AI Proxy

The API server acts as an OpenAI-compatible reverse proxy powered by Replit AI Integrations.

### Endpoints

- `GET /v1/models` — list available models (requires `Authorization: Bearer <PROXY_API_KEY>`)
- `POST /v1/chat/completions` — OpenAI-compatible chat (GPT + Claude models)
- `POST /v1/messages` — Anthropic native format (Claude only, for Claude Code)
- `GET /v1/stats` — usage statistics
- `GET /api/healthz` — health check

### Authentication

- OpenAI endpoints: `Authorization: Bearer $PROXY_API_KEY`
- Anthropic `/v1/messages`: `x-api-key: $PROXY_API_KEY`

### AI Integrations

- OpenAI (Azure): `AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`
- Anthropic (Vertex AI): `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` + `AI_INTEGRATIONS_ANTHROPIC_API_KEY`

### Proxy Architecture

Key server-side modules in `artifacts/api-server/src/proxy/`:
- `sse.ts` — shared SSE helpers (`startSSE`, `writeSSE`, `startKeepalive`, `endSSE`)
- `models.ts` — model registry with `claudeThinkingVariants` factory and `clampToModelCap` helper
- `openai.ts` — OpenAI/Azure proxy with streaming 429 retry and `cleanAzure` response normalization
- `anthropic.ts` — Anthropic/Vertex AI proxy split into 4 sub-functions (chat stream/non-stream, native stream/non-stream)
- `transform.ts` — Anthropic↔OpenAI format conversion with `buildSSEChunk` helper
- `ratelimit.ts` — Token-bucket rate limiter with `retryDelay()` helper
- `stats.ts` — Per-provider usage tracking (includes error durations)
- `errors.ts` — Structured error responses in OpenAI or Anthropic format
- `logger.ts` — Pino logger with `x-api-key` header redaction

### Portal

The API Portal (`artifacts/api-portal`) is a React SPA that gets built to `dist/public` and served as static files by the API server at `/`. Keep the portal dev workflow running for Replit's proxy routing.

Features: dynamic model list fetching, sessionStorage API key persistence, auto-refresh stats (30s), grouped model display by provider with thinking tags.

### Production Build

The API server's production build command (`artifact.toml`) first builds the portal with `BASE_PATH=/`, then builds the server, so the static files are available for serving.
