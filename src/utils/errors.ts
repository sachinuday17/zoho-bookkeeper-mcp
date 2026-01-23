/**
 * Error handling utilities for AI-friendly error messages
 */

// Known Zoho error codes and their meanings
const ZOHO_ERROR_CODES: Record<
  number,
  {
    message: string
    action: string
    category: "auth" | "validation" | "not_found" | "rate_limit" | "server"
  }
> = {
  0: { message: "Success", action: "No action needed", category: "validation" },
  1: {
    message: "Internal error",
    action: "Try again later or contact support",
    category: "server",
  },
  2: { message: "Invalid URL", action: "Check the API endpoint URL", category: "validation" },
  4: {
    message: "Invalid value",
    action: "Check the parameter values match expected types",
    category: "validation",
  },
  5: {
    message: "Invalid parameter",
    action: "Review required and optional parameters",
    category: "validation",
  },
  9: {
    message: "Record not found",
    action: "Verify the ID exists - use list endpoints to find valid IDs",
    category: "not_found",
  },
  10: {
    message: "Missing mandatory parameter",
    action: "Add the required parameter to your request",
    category: "validation",
  },
  14: {
    message: "Authorization failed",
    action: "Check your access token and permissions",
    category: "auth",
  },
  36: {
    message: "Rate limit exceeded",
    action: "Wait 1 minute before retrying",
    category: "rate_limit",
  },
  57: {
    message: "OAuth token expired",
    action: "Token will be auto-refreshed on next request",
    category: "auth",
  },
  2006: {
    message: "Record not found",
    action: "The specified resource does not exist. Use list endpoints to find valid IDs.",
    category: "not_found",
  },
  6000: {
    message: "Invalid OAuth token",
    action: "Token will be auto-refreshed on next request",
    category: "auth",
  },
}

export interface ZohoApiError {
  code: number
  message: string
  category: "auth" | "validation" | "not_found" | "rate_limit" | "server" | "unknown"
  suggestedAction: string
  endpoint?: string
  // Note: rawResponse intentionally omitted from interface to prevent leaking sensitive data
}

/**
 * Parse a Zoho API error response into an AI-friendly format
 * Note: rawResponse parameter kept for internal logging but NOT included in returned error
 * to prevent leaking sensitive data in error messages
 */
export function parseZohoError(
  code: number,
  apiMessage: string,
  endpoint?: string,
  _rawResponse?: string // Prefixed with _ to indicate intentionally unused (security)
): ZohoApiError {
  const knownError = ZOHO_ERROR_CODES[code]

  if (knownError) {
    return {
      code,
      message: apiMessage || knownError.message,
      category: knownError.category,
      suggestedAction: knownError.action,
      endpoint,
    }
  }

  // Unknown error code
  return {
    code,
    message: apiMessage || "Unknown error",
    category: "unknown",
    suggestedAction: "Check the Zoho Books API documentation for this error code",
    endpoint,
  }
}

/**
 * Format an error for display to the AI/user
 */
export function formatErrorForAI(error: ZohoApiError): string {
  let result = `**Zoho Error ${error.code}**: ${error.message}`

  if (error.suggestedAction) {
    result += `\n**Suggested Action**: ${error.suggestedAction}`
  }

  if (error.endpoint) {
    result += `\n**Endpoint**: ${error.endpoint}`
  }

  return result
}

/**
 * Format a generic error message
 */
export function formatGenericError(context: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `**Error in ${context}**: ${message}`
}

/**
 * Check if an error is a rate limit error
 */
export function isRateLimitError(error: ZohoApiError): boolean {
  return error.category === "rate_limit" || error.code === 36
}

/**
 * Check if an error is an auth error that might be resolved by token refresh
 */
export function isAuthError(error: ZohoApiError): boolean {
  return error.category === "auth" || [14, 57, 6000].includes(error.code)
}

/**
 * Check if an error indicates a not found resource
 */
export function isNotFoundError(error: ZohoApiError): boolean {
  return error.category === "not_found" || [9, 2006].includes(error.code)
}
