import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { createSocketServer } from "./socket/index.js";

const app = createApp(config.clientOrigins, config.trustProxy, config.staticDir);
const httpServer = createServer(app);
const { io } = createSocketServer(httpServer, config);

httpServer.listen(config.port, config.host, () => {
  console.log(`[server] DropFlow listening on http://${config.host}:${config.port}`);
  console.log(
    `[server] dev group: ${config.devGroupEnabled ? "on" : "off"}, network discovery: ${config.networkDiscovery}, TURN: ${config.turnUrls.length > 0 ? "configured" : "none"}`,
  );
});

function shutdown(signal: string) {
  console.log(`[server] ${signal} received, shutting down`);
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
