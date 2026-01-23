/**
 * Unit tests for error handling utilities
 */
import { describe, it, expect } from "vitest"
import {
  parseZohoError,
  formatErrorForAI,
  isRateLimitError,
  isAuthError,
  isNotFoundError,
} from "../../utils/errors.js"

describe("Error Handling Utilities", () => {
  describe("parseZohoError", () => {
    it("parses known error code 2006 (not found)", () => {
      const error = parseZohoError(2006, "Record not found", "/journals/123")

      expect(error.code).toBe(2006)
      expect(error.category).toBe("not_found")
      expect(error.suggestedAction).toContain("list endpoints")
      expect(error.endpoint).toBe("/journals/123")
    })

    it("parses known error code 36 (rate limit)", () => {
      const error = parseZohoError(36, "Rate limit exceeded", "/invoices")

      expect(error.code).toBe(36)
      expect(error.category).toBe("rate_limit")
      expect(error.suggestedAction).toContain("Wait")
    })

    it("parses known error code 14 (auth failed)", () => {
      const error = parseZohoError(14, "Authorization failed")

      expect(error.code).toBe(14)
      expect(error.category).toBe("auth")
    })

    it("parses known error code 4 (invalid value)", () => {
      const error = parseZohoError(4, "Invalid value for amount")

      expect(error.code).toBe(4)
      expect(error.category).toBe("validation")
    })

    it("handles unknown error codes", () => {
      const error = parseZohoError(99999, "Unknown error occurred")

      expect(error.code).toBe(99999)
      expect(error.category).toBe("unknown")
      expect(error.suggestedAction).toContain("documentation")
    })

    it("does not include raw response for security (prevents data leakage)", () => {
      const rawResponse = '{"code":4,"message":"Invalid"}'
      const error = parseZohoError(4, "Invalid", "/test", rawResponse)

      // Security: rawResponse is intentionally not included to prevent sensitive data leakage
      expect(error).not.toHaveProperty("rawResponse")
    })
  })

  describe("formatErrorForAI", () => {
    it("formats error with all details", () => {
      const error = parseZohoError(2006, "Record not found", "/journals/123")
      const formatted = formatErrorForAI(error)

      expect(formatted).toContain("**Zoho Error 2006**")
      expect(formatted).toContain("Record not found")
      expect(formatted).toContain("**Suggested Action**")
      expect(formatted).toContain("**Endpoint**")
      expect(formatted).toContain("/journals/123")
    })

    it("formats error without endpoint", () => {
      const error = parseZohoError(36, "Rate limit exceeded")
      const formatted = formatErrorForAI(error)

      expect(formatted).toContain("**Zoho Error 36**")
      expect(formatted).not.toContain("**Endpoint**")
    })
  })

  describe("error type checks", () => {
    it("isRateLimitError returns true for rate limit errors", () => {
      const error = parseZohoError(36, "Rate limit exceeded")
      expect(isRateLimitError(error)).toBe(true)
    })

    it("isRateLimitError returns false for other errors", () => {
      const error = parseZohoError(2006, "Not found")
      expect(isRateLimitError(error)).toBe(false)
    })

    it("isAuthError returns true for auth errors", () => {
      expect(isAuthError(parseZohoError(14, "Auth failed"))).toBe(true)
      expect(isAuthError(parseZohoError(57, "Token expired"))).toBe(true)
      expect(isAuthError(parseZohoError(6000, "Invalid token"))).toBe(true)
    })

    it("isAuthError returns false for non-auth errors", () => {
      const error = parseZohoError(4, "Invalid value")
      expect(isAuthError(error)).toBe(false)
    })

    it("isNotFoundError returns true for not found errors", () => {
      expect(isNotFoundError(parseZohoError(9, "Record not found"))).toBe(true)
      expect(isNotFoundError(parseZohoError(2006, "Record not found"))).toBe(true)
    })

    it("isNotFoundError returns false for other errors", () => {
      const error = parseZohoError(4, "Invalid value")
      expect(isNotFoundError(error)).toBe(false)
    })
  })
})
