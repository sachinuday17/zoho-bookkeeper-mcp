/**
 * HTTP server entry point
 *
 * stateless: true — required for Claude.ai remote MCP connections.
 * Claude.ai does not maintain session state between requests; stateful
 * mode (the FastMCP default) would reject requests without Mcp-Session-Id.
 */

import server from "./index.js"
import { getServerConfig } from "./config.js"

const config = getServerConfig()

server.start({
  transportType: "httpStream",
  httpStream: {
    port: config.port,
    host: config.host,
    stateless: true,
  },
})

console.log(`[server] Zoho Bookkeeper MCP running on http://${config.host}:${config.port}`)
console.log(`[server] Health:  http://${config.host}:${config.port}/health`)
console.log(`[server] MCP:     http://${config.host}:${config.port}/mcp`)
console.log(`[server] Auth:    ${config.apiKey ? "bearer-token enabled" : "OPEN — set MCP_API_KEY in Railway"}`)
