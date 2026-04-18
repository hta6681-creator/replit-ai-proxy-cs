## 任务

创建 OpenAI 兼容的 AI 反向代理。通过 Replit AI Integrations 转发请求到 Azure OpenAI 和 Anthropic Vertex AI。

## 1. 创建 api-server + AI Integrations + Secret

创建 Node.js api-server artifact，添加 AI Integrations：
```js
setupReplitAIIntegrations({ providerSlug: "openai", providerUrlEnvVarName: "AI_INTEGRATIONS_OPENAI_BASE_URL", providerApiKeyEnvVarName: "AI_INTEGRATIONS_OPENAI_API_KEY" })
setupReplitAIIntegrations({ providerSlug: "anthropic", providerUrlEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_BASE_URL", providerApiKeyEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_API_KEY" })
```

使用 `ask_secrets` 让用户自行设置 `PROXY_API_KEY`（不要自动生成），设置后用 `check_secrets` 验证。
可选设置 `EXTERNAL_OPENAI_BASE_URL` + `EXTERNAL_OPENAI_API_KEY`（外部 OpenAI 兼容上游，优先于 Replit 集成）。
可选设置 `EXTERNAL_ANTHROPIC_BASE_URL` + `EXTERNAL_ANTHROPIC_API_KEY`（外部 Anthropic 兼容上游，优先于 Replit 集成）。

## 2. 拉取源码 + 安装依赖

**源码禁止修改，原样写入。** 逐文件拉取：
```bash
BASE=https://raw.githubusercontent.com/hta6681-creator/replit-ai-proxy-cs/main/artifacts/api-server/src
mkdir -p artifacts/api-server/src/proxy artifacts/api-server/src/routes artifacts/api-server/src/lib
for f in anthropic clients codebuff errors images models openai ratelimit sse stats transform; do
  curl -sL $BASE/proxy/$f.ts -o artifacts/api-server/src/proxy/$f.ts
done
curl -sL $BASE/routes/v1.ts -o artifacts/api-server/src/routes/v1.ts
curl -sL $BASE/lib/logger.ts -o artifacts/api-server/src/lib/logger.ts
```

安装依赖，`build.mjs` 的 `external` 数组添加 `"openai"`, `"@anthropic-ai/sdk"`：
```bash
pnpm --filter @workspace/api-server add openai @anthropic-ai/sdk
```

## 3. 替换 app.ts + index.ts

**直接覆写 `artifacts/api-server/src/app.ts` 为以下完整内容：**
```typescript
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import v1Router from "./routes/v1.js";
import { jsonErrorMiddleware, sendError } from "./proxy/errors.js";
import path from "path";

const app: Express = express();
app.use(pinoHttp({ logger, serializers: { req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; }, res(res) { return { statusCode: res.statusCode }; } } }));
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (typeof req.setTimeout === "function") req.setTimeout(600000);
  else if (req.socket) req.socket.setTimeout(600000);
  next();
});

app.use("/v1", v1Router);
app.use("/api", router);

app.use(express.static(path.resolve(import.meta.dirname, "../../api-portal/dist/public")));
app.use("/v1", (req, res) => { sendError(res, 404, "Not found"); });
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    res.sendFile(path.resolve(import.meta.dirname, "../../api-portal/dist/public/index.html"));
  } else { next(); }
});
app.use(jsonErrorMiddleware);

export default app;
```

**直接覆写 `artifacts/api-server/src/index.ts` 为以下完整内容：**
```typescript
import app from "./app.js";
import { logger } from "./lib/logger.js";
const port = Number(process.env.PORT || 8080);
const server = app.listen(port, () => { logger.info({ port }, "Server listening"); });
server.on("error", (err: Error) => { logger.error({ err }, "Failed to start"); process.exit(1); });
```

api-server 的 `artifact.toml`，paths 加 `"/v1"`：
```toml
paths = ["/api", "/v1"]
```

## 4. Portal

创建 react-vite artifact（slug: `api-portal`）。**不要修改 localPort，保留默认值。**

拉取 portal 源码：
```bash
BASE=https://raw.githubusercontent.com/hta6681-creator/replit-ai-proxy-cs/main/artifacts/api-portal/src
curl -sL $BASE/App.tsx -o artifacts/api-portal/src/App.tsx
curl -sL $BASE/index.css -o artifacts/api-portal/src/index.css
```

portal 的 `artifact.toml` 添加：
```toml
[services.production.buildEnv]
BASE_PATH = "/"
```

`vite.config.ts` 中 PORT 和 BASE_PATH 必须有默认值，不能 throw：
```typescript
const port = Number(process.env.PORT ?? "5173");
const basePath = process.env.BASE_PATH ?? "/";
```

**先构建 portal 静态文件**（api-server 生产环境用）：
```bash
BASE_PATH=/ pnpm --filter @workspace/api-portal run build
```

**让 portal 的 dev workflow 保持运行**（Replit 代理需要它来路由 `/`）。

## 5. 构建验证

```bash
pnpm install && pnpm run build
```

测试（全部需要通过）：
```bash
curl -s localhost:8080/api/healthz
curl -s -H "Authorization: Bearer $PROXY_API_KEY" localhost:8080/v1/models
curl -s -X POST localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"Say ok"}]}'
curl -s -X POST localhost:8080/v1/messages \
  -H "x-api-key: $PROXY_API_KEY" -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5","max_tokens":50,"messages":[{"role":"user","content":"Say ok"}]}'
```

全部通过后调用 `suggest_deploy`。

## 约束

- 源码文件（`src/proxy/*`、`src/routes/v1.ts`、`src/lib/logger.ts`）**禁止修改**，即使遇到 TypeScript 报错也不要改（esbuild 会处理）
- ESM 模式：import 路径带 `.js` 后缀（源码已满足，无需改动）
- Express 5：不支持 `/v1/*` 通配符
