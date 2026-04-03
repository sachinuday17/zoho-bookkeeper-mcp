/**
 * HTTP server entry point
 *
 * stateless: true — required for Claude.ai remote MCP connections.
 * Claude.ai sends standalone HTTP POST requests without session state.
 */

import server from "./index.js"
import { getServerConfig } from "./config.js"

const config = getServerConfig()
const port = config.port
const host = config.host

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
