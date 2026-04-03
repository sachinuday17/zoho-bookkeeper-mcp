/**
 * OAuth token management — per-client token cache
 *
 * Each configured client (slug) gets its own cached access token.
 * Token is refreshed automatically 5 minutes before expiry.
 * Thread-safe: Node.js is single-threaded; concurrent awaits deduplicate via
 * the promise cache (pendingRefreshes map).
 */

import { getActiveClient, getZohoConfig, getZohoOAuthUrl, validateZohoConfig } from "../config.js"
import type { ClientConfig } from "../config.js"

interface TokenState {
  accessToken: string
  expiresAt: number // epoch ms
}

// Per-client token cache — keyed by client slug
const tokenCache = new Map<string, TokenState>()

// Deduplicate concurrent refresh requests for the same client
const pendingRefreshes = new Map<string, Promise<string>>()

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000 // 5 min

/**
 * Error class for OAuth-related errors — kept for backward compat with api/client.ts
 */
export class ZohoAuthError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly statusCode?: number
  ) {
    super(message)
    this.name = "ZohoAuthError"
  }
}

/**
 * Get a valid access token for the currently active client.
 *
 * Called by api/client.ts with no arguments — it internally uses
 * getActiveClient() so the correct credentials are used for whoever
 * is the active client at call time.
 */
export async function getAccessToken(): Promise<string> {
  const client = getActiveClient()
  return getAccessTokenForClient(client)
}

/**
 * Get a valid access token for a specific client (used internally).
 */
export async function getAccessTokenForClient(client: ClientConfig): Promise<string> {
  const cached = tokenCache.get(client.slug)

  // Return cached token if still fresh (with 5-min buffer)
  if (cached && Date.now() < cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return cached.accessToken
  }

  // Deduplicate concurrent refresh requests for the same client
  const existing = pendingRefreshes.get(client.slug)
  if (existing) return existing

  const refreshPromise = refreshTokenForClient(client).finally(() => {
    pendingRefreshes.delete(client.slug)
  })

  pendingRefreshes.set(client.slug, refreshPromise)
  return refreshPromise
}

async function refreshTokenForClient(client: ClientConfig): Promise<string> {
  // Validate credentials before attempting refresh
  const config = getZohoConfig() // gets active client config
  const validation = validateZohoConfig(config)

  if (!validation.valid) {
    throw new ZohoAuthError(
      `OAuth not configured for client "${client.slug}": ${validation.error}`,
      "OAUTH_NOT_CONFIGURED"
    )
  }

  const oauthUrl = client.oauthUrl || getZohoOAuthUrl(client.apiUrl)

  let response: Response
  try {
    response = await fetch(oauthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: client.refreshToken,
      }),
    })
  } catch (err) {
    throw new ZohoAuthError(
      `Network error refreshing token for "${client.slug}": ${err instanceof Error ? err.message : String(err)}`,
      "NETWORK_ERROR"
    )
  }

  let data: Record<string, unknown>
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    throw new ZohoAuthError(
      `Non-JSON response from OAuth server for "${client.slug}" (HTTP ${response.status})`,
      "INVALID_RESPONSE"
    )
  }

  if (!response.ok) {
    const errMsg = (data.error_description as string) || (data.error as string) || "Unknown error"
    throw new ZohoAuthError(
      `Token refresh failed for "${client.slug}": ${errMsg}`,
      data.error as string | undefined,
      response.status
    )
  }

  const accessToken = data.access_token as string | undefined
  if (!accessToken) {
    throw new ZohoAuthError(
      `No access_token in response for "${client.slug}"`,
      "NO_ACCESS_TOKEN"
    )
  }

  const expiresIn = (data.expires_in as number | undefined) ?? 3600
  const state: TokenState = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  }

  tokenCache.set(client.slug, state)
  // Security: log slug and expiry only — never the token itself
  console.log(
    `[oauth] Token refreshed for "${client.slug}" — expires in ${Math.round(expiresIn / 60)}m`
  )

  return accessToken
}

/**
 * Invalidate the cached token for a specific client slug.
 * Forces a fresh token fetch on the next API call.
 */
export function invalidateToken(slug: string): void {
  tokenCache.delete(slug)
  console.log(`[oauth] Token cache cleared for "${slug}"`)
}

/**
 * Invalidate all cached tokens (e.g., on credential rotation).
 */
export function invalidateAllTokens(): void {
  tokenCache.clear()
  console.log("[oauth] All token caches cleared")
}

/**
 * Check if active client credentials are configured (without refreshing).
 */
export function isConfigured(): boolean {
  try {
    const client = getActiveClient()
    return Boolean(client.clientId && client.clientSecret && client.refreshToken)
  } catch {
    return false
  }
}

/**
 * Clear the cached token — kept for backward compat with tests.
 */
export function clearTokenCache(): void {
  tokenCache.clear()
}
