/**
 * Client Switcher Tools
 *
 * Enables Claude to manage multiple Zoho Books clients (companies) within a
 * single MCP session. Say "switch to Acoustic Interio" and all subsequent
 * tool calls automatically use that client's credentials and org ID.
 *
 * Tools:
 *   list_clients       — see all configured companies
 *   set_active_client  — switch the active company
 *   get_active_client  — confirm which company is currently active
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import {
  getActiveClient,
  getActiveSlug,
  listClients,
  setActiveClient,
} from "../config.js"
import { invalidateToken } from "../auth/oauth.js"

export function registerClientSwitcherTools(server: FastMCP): void {

  // ── list_clients ───────────────────────────────────────────────────────────

  server.addTool({
    name: "list_clients",
    description: `List all configured Zoho Books clients (companies).
Shows which client is currently active (▶) and each client's org ID.
Call this before set_active_client to see available slugs.
Add new clients in Railway by adding CLIENT_<SLUG>_* env vars — no code changes needed.`,
    parameters: z.object({}),
    annotations: { title: "List Clients", readOnlyHint: true, openWorldHint: false },
    execute: async () => {
      const clients = listClients()
      const active = getActiveSlug()

      const rows = clients.map((c) => {
        const marker = c.slug === active ? "▶" : " "
        const name = c.displayName.padEnd(30)
        const slug = c.slug.padEnd(18)
        return `${marker} ${slug} ${name} org:${c.orgId}`
      })

      return [
        `**Zoho Books Clients** (${clients.length} configured)`,
        "",
        "  Slug               Display Name                   Org ID",
        "  " + "─".repeat(70),
        rows.join("\n"),
        "",
        `Active: **${active}**`,
        "",
        "Use set_active_client to switch.",
      ].join("\n")
    },
  })

  // ── set_active_client ──────────────────────────────────────────────────────

  server.addTool({
    name: "set_active_client",
    description: `Switch to a different Zoho Books client (company).
All subsequent tool calls will use this client's credentials and org ID.
Use list_clients to see available slugs.

Example: set_active_client("acoustic") switches to Acoustic Interio.
The change persists for the duration of this conversation session.`,
    parameters: z.object({
      client_slug: z
        .string()
        .min(1)
        .describe(
          "Slug of the client to switch to (e.g. 'flutch', 'acoustic'). Case-insensitive. Use list_clients to see all slugs."
        ),
    }),
    annotations: { title: "Switch Active Client", readOnlyHint: false, openWorldHint: false },
    execute: async ({ client_slug }) => {
      let client
      try {
        client = setActiveClient(client_slug)
      } catch (err) {
        return `**Switch Failed**\n\n${err instanceof Error ? err.message : String(err)}\n\nRun list_clients to see available client slugs.`
      }

      return [
        `**Client Switched** ✅`,
        "",
        `- **Active Client**: ${client.displayName}`,
        `- **Slug**: \`${client.slug}\``,
        `- **Org ID**: \`${client.orgId}\``,
        `- **API**: ${client.apiUrl}`,
        "",
        "All tools are now operating on this client's Zoho Books account.",
      ].join("\n")
    },
  })

  // ── get_active_client ──────────────────────────────────────────────────────

  server.addTool({
    name: "get_active_client",
    description: `Show which Zoho Books client (company) is currently active.
Call this to confirm the active client before performing write operations.`,
    parameters: z.object({}),
    annotations: { title: "Get Active Client", readOnlyHint: true, openWorldHint: false },
    execute: async () => {
      const client = getActiveClient()
      const all = listClients()

      return [
        `**Active Client**`,
        "",
        `- **Name**: ${client.displayName}`,
        `- **Slug**: \`${client.slug}\``,
        `- **Org ID**: \`${client.orgId}\``,
        `- **API Region**: ${client.apiUrl}`,
        "",
        `${all.length} client(s) configured total. Use list_clients to see all.`,
      ].join("\n")
    },
  })

  // ── refresh_client_token ───────────────────────────────────────────────────

  server.addTool({
    name: "refresh_client_token",
    description: `Force a fresh OAuth token refresh for a client.
Use if you're seeing authentication errors for a specific client.
By default refreshes the active client. Pass client_slug to target another.`,
    parameters: z.object({
      client_slug: z
        .string()
        .optional()
        .describe("Slug of the client to refresh (defaults to active client)"),
    }),
    annotations: { title: "Refresh Client Token", readOnlyHint: false, openWorldHint: false },
    execute: async ({ client_slug }) => {
      const slug = client_slug ?? getActiveSlug()
      invalidateToken(slug)
      return `**Token cache cleared** for client \`${slug}\`.\n\nThe next API call will trigger a fresh OAuth token refresh.`
    },
  })
}
