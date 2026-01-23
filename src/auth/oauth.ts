/**
 * OAuth token management for Zoho Books API
 */

import { getZohoConfig, getZohoOAuthUrl, validateZohoConfig } from "../config.js"

interface TokenState {
  accessToken: string
  expiresAt: number
}

// Token state (module-level for caching)
let tokenState: TokenState | null = null

// Token expiry buffer (5 minutes before actual expiry)
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000

/**
 * Error class for OAuth-related errors
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
 * Get a valid access token, refreshing if necessary
 */
export async function getAccessToken(): Promise<string> {
  const config = getZohoConfig()
  const validation = validateZohoConfig(config)

  if (!validation.valid) {
    throw new ZohoAuthError(
      `Zoho OAuth not configured: ${validation.error}. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN.`,
      "OAUTH_NOT_CONFIGURED"
    )
  }

  // Return cached token if still valid (with 5-minute buffer)
  if (tokenState && Date.now() < tokenState.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return tokenState.accessToken
  }

  // Refresh the token
  return refreshAccessToken(config)
}

/**
 * Refresh the access token using the refresh token
 */
async function refreshAccessToken(config: {
  clientId: string
  clientSecret: string
  refreshToken: string
  apiUrl: string
}): Promise<string> {
  const oauthUrl = getZohoOAuthUrl(config.apiUrl)

  try {
    const response = await fetch(oauthUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      const errorMessage = data.error_description || data.error || "Unknown error"
      throw new ZohoAuthError(
        `Failed to refresh token: ${errorMessage}`,
        data.error,
        response.status
      )
    }

    if (!data.access_token) {
      throw new ZohoAuthError("No access token in response", "NO_ACCESS_TOKEN")
    }

    // Store the new token with expiry (default 1 hour if not specified)
    const expiresIn = data.expires_in || 3600
    tokenState = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    }

    // Security: Removed console.log to prevent token refresh timing leakage in logs
    return tokenState.accessToken
  } catch (error) {
    if (error instanceof ZohoAuthError) {
      throw error
    }
    throw new ZohoAuthError(
      `Failed to refresh token: ${error instanceof Error ? error.message : String(error)}`,
      "REFRESH_FAILED"
    )
  }
}

/**
 * Clear the cached token (useful for testing or forcing refresh)
 */
export function clearTokenCache(): void {
  tokenState = null
}

/**
 * Check if credentials are configured (without attempting to refresh)
 */
export function isConfigured(): boolean {
  const config = getZohoConfig()
  return validateZohoConfig(config).valid
}
