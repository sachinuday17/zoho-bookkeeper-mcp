/**
 * Environment configuration for Zoho Bookkeeper MCP Server
 */

// Security constants
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
export const REQUEST_TIMEOUT_MS = 30000 // 30 seconds

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
}

export interface Config {
  zoho: ZohoConfig
  server: ServerConfig
}

/**
 * Get Zoho API configuration from environment variables
 */
export function getZohoConfig(): ZohoConfig {
  const clientId = process.env.ZOHO_CLIENT_ID || ""
  const clientSecret = process.env.ZOHO_CLIENT_SECRET || ""
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN || ""
  const apiUrl = process.env.ZOHO_API_URL || "https://www.zohoapis.com/books/v3"
  const organizationId = process.env.ZOHO_ORGANIZATION_ID || ""

  return {
    clientId,
    clientSecret,
    refreshToken,
    apiUrl,
    organizationId,
  }
}

/**
 * Get server configuration from environment variables
 */
export function getServerConfig(): ServerConfig {
  return {
    port: parseInt(process.env.PORT || "8004", 10),
    host: process.env.HOST || "0.0.0.0",
  }
}

/**
 * Get full configuration
 */
export function getConfig(): Config {
  return {
    zoho: getZohoConfig(),
    server: getServerConfig(),
  }
}

/**
 * Validate that required Zoho credentials are configured
 */
export function validateZohoConfig(config: ZohoConfig): { valid: boolean; error?: string } {
  if (!config.clientId) {
    return { valid: false, error: "ZOHO_CLIENT_ID is not configured" }
  }
  if (!config.clientSecret) {
    return { valid: false, error: "ZOHO_CLIENT_SECRET is not configured" }
  }
  if (!config.refreshToken) {
    return { valid: false, error: "ZOHO_REFRESH_TOKEN is not configured" }
  }
  // Security: Enforce HTTPS for API URL
  if (!config.apiUrl.startsWith("https://")) {
    return { valid: false, error: "ZOHO_API_URL must use HTTPS" }
  }
  return { valid: true }
}

/**
 * Get Zoho OAuth token URL based on the API URL region
 */
export function getZohoOAuthUrl(apiUrl: string): string {
  // Map API URLs to their corresponding OAuth URLs
  if (apiUrl.includes("zohoapis.eu")) {
    return "https://accounts.zoho.eu/oauth/v2/token"
  }
  if (apiUrl.includes("zohoapis.in")) {
    return "https://accounts.zoho.in/oauth/v2/token"
  }
  if (apiUrl.includes("zohoapis.com.au")) {
    return "https://accounts.zoho.com.au/oauth/v2/token"
  }
  // Default to US
  return "https://accounts.zoho.com/oauth/v2/token"
}
