import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "cors";
import express from "express";
import { healthRouter } from "./routes/health.js";

export function createApp(origins: string[], trustProxy = false, staticDir: string | null = null) {
  const app = express();

  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", true);
  app.use(cors({ origin: origins }));
  app.use(express.json({ limit: "16kb" }));

  app.use(healthRouter);

  if (staticDir && existsSync(resolve(staticDir, "index.html"))) {
    app.use(express.static(staticDir, { index: "index.html", maxAge: "1h" }));
    app.get(/^\/(?!socket\.io\/).*/, (_req, res) => res.sendFile(resolve(staticDir, "index.html")));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
