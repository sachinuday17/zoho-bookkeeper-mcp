/**
 * Zoho Bookkeeper MCP — Configuration
 *
 * Supports BOTH single-client and multi-client modes:
 *
 * Multi-client (preferred for CA firms):
 *   CLIENT_<SLUG>_NAME=Acme Ltd
 *   CLIENT_<SLUG>_CLIENT_ID=1000.xxx
 *   CLIENT_<SLUG>_CLIENT_SECRET=xxx
 *   CLIENT_<SLUG>_REFRESH_TOKEN=1000.xxx
 *   CLIENT_<SLUG>_ORG_ID=60012345678
 *   CLIENT_<SLUG>_API_URL=https://www.zohoapis.in/books/v3   (optional, defaults to .in)
 *
 * Single-client fallback (backward compatible):
 *   ZOHO_CLIENT_ID=1000.xxx
 *   ZOHO_CLIENT_SECRET=xxx
 *   ZOHO_REFRESH_TOKEN=1000.xxx
 *   ZOHO_ORGANIZATION_ID=60012345678
 *   ZOHO_API_URL=https://www.zohoapis.in/books/v3   (optional)
 *
 * Security:
 *   MCP_API_KEY=<strong-random-string>   — Bearer token gate on the MCP endpoint
 */

// ── Security / upload constants ───────────────────────────────────────────────
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB
export const REQUEST_TIMEOUT_MS = 30_000 // 30 s

// ── Client config shape ───────────────────────────────────────────────────────

export interface ClientConfig {
  slug: string
  displayName: string
  clientId: string
  clientSecret: string
  refreshToken: string
  orgId: string
  apiUrl: string
  oauthUrl: string // derived from apiUrl
}

// ── Legacy shape — kept so api/client.ts and oauth.ts compile unchanged ───────

export interface ZohoConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  apiUrl: string
  organizationId: string
}

export interface ServerConfig {
  port: number
  host: string
  apiKey: string // MCP_API_KEY — empty string means no auth gate (dev mode only)
}

// ── OAuth URL derivation ──────────────────────────────────────────────────────

function deriveOAuthUrl(apiUrl: string): string {
  if (apiUrl.includes("zohoapis.eu")) return "https://accounts.zoho.eu/oauth/v2/token"
  if (apiUrl.includes("zohoapis.in")) return "https://accounts.zoho.in/oauth/v2/token"
  if (apiUrl.includes("zohoapis.com.au")) return "https://accounts.zoho.com.au/oauth/v2/token"
  if (apiUrl.includes("zohoapis.jp")) return "https://accounts.zoho.jp/oauth/v2/token"
  if (apiUrl.includes("zohoapis.ca")) return "https://accounts.zohocloud.ca/oauth/v2/token"
  return "https://accounts.zoho.com/oauth/v2/token" // US default
}

// ── Multi-client registry ─────────────────────────────────────────────────────

function loadClients(): Map<string, ClientConfig> {
  const clients = new Map<string, ClientConfig>()

  // ── Pass 1: scan for CLIENT_<SLUG>_CLIENT_ID pattern ──────────────────────
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^CLIENT_([A-Z0-9_]+)_CLIENT_ID$/)
    if (!match) continue

    const slug = match[1].toLowerCase()
    const prefix = `CLIENT_${match[1]}`

    const clientId = process.env[`${prefix}_CLIENT_ID`] ?? ""
    const clientSecret = process.env[`${prefix}_CLIENT_SECRET`] ?? ""
    const refreshToken = process.env[`${prefix}_REFRESH_TOKEN`] ?? ""
    const orgId = process.env[`${prefix}_ORG_ID`] ?? ""
    const displayName = process.env[`${prefix}_NAME`] ?? slug
    const apiUrl = (process.env[`${prefix}_API_URL`] ?? "https://www.zohoapis.in/books/v3").trimEnd().replace(/\/$/, "")

    if (!clientId || !clientSecret || !refreshToken || !orgId) {
      console.warn(`[config] Skipping client "${slug}" — missing one or more: _CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN, _ORG_ID`)
      continue
    }

    if (!apiUrl.startsWith("https://")) {
      console.warn(`[config] Skipping client "${slug}" — API URL must use HTTPS: ${apiUrl}`)
      continue
    }

    clients.set(slug, {
      slug,
      displayName,
      clientId,
      clientSecret,
      refreshToken,
      orgId,
      apiUrl,
      oauthUrl: deriveOAuthUrl(apiUrl),
    })
  }

  // ── Pass 2: fallback to single-client ZOHO_* env vars ─────────────────────
  if (clients.size === 0) {
    const clientId = process.env.ZOHO_CLIENT_ID ?? ""
    const clientSecret = process.env.ZOHO_CLIENT_SECRET ?? ""
    const refreshToken = process.env.ZOHO_REFRESH_TOKEN ?? ""
    const orgId = process.env.ZOHO_ORGANIZATION_ID ?? ""
    const apiUrl = (process.env.ZOHO_API_URL ?? "https://www.zohoapis.in/books/v3").trimEnd().replace(/\/$/, "")

    if (clientId && clientSecret && refreshToken) {
      clients.set("default", {
        slug: "default",
        displayName: process.env.ZOHO_CLIENT_NAME ?? "Default Client",
        clientId,
        clientSecret,
        refreshToken,
        orgId,
        apiUrl,
        oauthUrl: deriveOAuthUrl(apiUrl),
      })
      console.log("[config] Running in single-client mode (ZOHO_* env vars)")
    }
  }

  if (clients.size === 0) {
    throw new Error(
      "No Zoho clients configured.\n" +
      "Multi-client: add CLIENT_<SLUG>_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN / _ORG_ID\n" +
      "Single-client: add ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN"
    )
  }

  const names = [...clients.keys()].join(", ")
  console.log(`[config] Loaded ${clients.size} client(s): ${names}`)
  return clients
}

// ── Exported client registry ──────────────────────────────────────────────────

export const _clientRegistry: Map<string, ClientConfig> = loadClients()

let _activeSlug: string = _clientRegistry.keys().next().value as string

export function getActiveClient(): ClientConfig {
  const client = _clientRegistry.get(_activeSlug)
  if (!client) throw new Error(`Active client "${_activeSlug}" not found in registry — this should never happen`)
  return client
}

export function setActiveClient(slug: string): ClientConfig {
  const normalized = slug.toLowerCase().trim()
  if (!_clientRegistry.has(normalized)) {
    const available = [..._clientRegistry.keys()].join(", ")
    throw new Error(`Client "${slug}" not found. Available clients: ${available}`)
  }
  const prev = _activeSlug
  _activeSlug = normalized
  const client = _clientRegistry.get(normalized)!
  console.log(`[config] Active client: ${prev} → ${normalized} (org: ${client.orgId})`)
  return client
}

export function listClients(): ClientConfig[] {
  return [..._clientRegistry.values()]
}

export function getActiveSlug(): string {
  return _activeSlug
}

// ── Server config ─────────────────────────────────────────────────────────────

export function getServerConfig(): ServerConfig {
  return {
    port: parseInt(process.env.PORT ?? "8004", 10),
    host: process.env.HOST ?? "0.0.0.0",
    apiKey: process.env.MCP_API_KEY ?? "",
  }
}

// ── Legacy compatibility — api/client.ts and oauth.ts import these ────────────
// These functions always return the ACTIVE CLIENT's config, making all existing
// tool files (journals, invoices, expenses etc.) automatically multi-client aware
// without requiring any changes to those files.

export function getZohoConfig(): ZohoConfig {
  const client = getActiveClient()
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    refreshToken: client.refreshToken,
    apiUrl: client.apiUrl,
    organizationId: client.orgId,
  }
}

export function validateZohoConfig(config: ZohoConfig): { valid: boolean; error?: string } {
  if (!config.clientId) return { valid: false, error: "Client ID not configured" }
  if (!config.clientSecret) return { valid: false, error: "Client secret not configured" }
  if (!config.refreshToken) return { valid: false, error: "Refresh token not configured" }
  if (!config.apiUrl.startsWith("https://")) return { valid: false, error: "API URL must use HTTPS" }
  return { valid: true }
}

/** Maps API URL to OAuth token endpoint — kept for backward compat with oauth.ts */
export function getZohoOAuthUrl(apiUrl: string): string {
  return deriveOAuthUrl(apiUrl)
}
