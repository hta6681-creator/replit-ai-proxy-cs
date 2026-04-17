import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import v1Router from "./routes/v1.js";
import { jsonErrorMiddleware, sendError } from "./proxy/errors.js";
import path from "path";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  if (typeof req.setTimeout === "function") req.setTimeout(600000);
  else if (req.socket) req.socket.setTimeout(600000);
  next();
});

app.use("/v1", v1Router);
app.use("/api", router);

const portalDir = path.resolve(
  import.meta.dirname,
  "../../api-portal/dist/public",
);

app.use(express.static(portalDir));

app.use("/v1", (_req, res) => {
  sendError(res, 404, "Not found");
});

app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    res.sendFile(path.resolve(portalDir, "index.html"));
  } else {
    next();
  }
});

app.use(jsonErrorMiddleware);

export default app;
