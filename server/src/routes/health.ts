import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "dropflow-server",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
