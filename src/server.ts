/**
 * HTTP server entry point
 *
 * stateless: true — required for Claude.ai remote MCP connections.
 * Claude.ai sends standalone HTTP POST requests without session state.
 *
 * HEAD /mcp fix: Claude.ai sends HEAD /mcp as a connectivity probe before
 * connecting. mcp-proxy's handleStreamRequest only registers POST on /mcp,
 * so HEAD falls through to onUnhandledRequest → FastMCP's Hono app.
 * Without an explicit handler, Hono returns 404, and Claude.ai reports
 * "Couldn't reach the MCP server". We register a Hono middleware that
 * intercepts HEAD /mcp and returns 200 before the 404 path is reached.
 */

import server from "./index.js"
import { getServerConfig } from "./config.js"

const config = getServerConfig()
const port = config.port
const host = config.host

// ── HEAD /mcp — Claude.ai connector verification ──────────────────────────────
// Must be registered BEFORE server.start() so the Hono router has it available
// when the first request arrives.
const honoApp = server.getApp()
honoApp.use("/mcp", async (c, next) => {
  if (c.req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "MCP-Protocol-Version": "2024-11-05",
        "Content-Length": "0",
      },
    })
  }
  return next()
})

console.log(`[server] Starting Zoho Bookkeeper MCP...`)
console.log(`[server] Node: ${process.version}`)
console.log(`[server] PORT env: ${process.env.PORT ?? "(not set, using 8004)"}`)
console.log(`[server] Binding to: ${host}:${port}`)
console.log(`[server] Auth: ${config.apiKey ? "bearer-token enabled" : "OPEN — set MCP_API_KEY"}`)

process.on("uncaughtException", (err) => {
  console.error("[server] UNCAUGHT EXCEPTION:", err)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  console.error("[server] UNHANDLED REJECTION:", reason)
  process.exit(1)
})

try {
  await server.start({
    transportType: "httpStream",
    httpStream: {
      port,
      host,
      stateless: true,
    },
  })

  console.log(`[server] ✅ Ready`)
  console.log(`[server] Health: http://${host}:${port}/health`)
  console.log(`[server] MCP:    http://${host}:${port}/mcp`)
} catch (err) {
  console.error("[server] FAILED TO START:", err)
  process.exit(1)
}
