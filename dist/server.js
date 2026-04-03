import {
  getServerConfig,
  src_default
} from "./chunk-NJPCWBVP.js";

// src/server.ts
var config = getServerConfig();
var port = config.port;
var host = config.host;
console.log(`[server] Starting Zoho Bookkeeper MCP...`);
console.log(`[server] Node: ${process.version}`);
console.log(`[server] PORT env: ${process.env.PORT ?? "(not set, using 8004)"}`);
console.log(`[server] Binding to: ${host}:${port}`);
console.log(`[server] Auth: ${config.apiKey ? "bearer-token enabled" : "OPEN \u2014 set MCP_API_KEY"}`);
process.on("uncaughtException", (err) => {
  console.error("[server] UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] UNHANDLED REJECTION:", reason);
  process.exit(1);
});
try {
  await src_default.start({
    transportType: "httpStream",
    httpStream: {
      port,
      host,
      stateless: true
    }
  });
  console.log(`[server] \u2705 Ready`);
  console.log(`[server] Health: http://${host}:${port}/health`);
  console.log(`[server] MCP:    http://${host}:${port}/mcp`);
} catch (err) {
  console.error("[server] FAILED TO START:", err);
  process.exit(1);
}
