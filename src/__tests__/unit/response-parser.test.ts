/**
 * Tests for response-parser utilities
 */

import { describe, it, expect } from "vitest"
import {
  parseZohoResponse,
  extractData,
  formatSuccessMessage,
  formatListResponse,
} from "../../utils/response-parser.js"

describe("Response Parser", () => {
  describe("parseZohoResponse", () => {
    it("parses successful JSON response", async () => {
      const response = new Response(JSON.stringify({ code: 0, journal: { id: "123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })

      const result = await parseZohoResponse(response, "/journals")

      expect(result.ok).toBe(true)
      expect(result.data).toEqual({ code: 0, journal: { id: "123" } })
    })

    it("handles Zoho error code in response", async () => {
      const response = new Response(
        JSON.stringify({ code: 1002, message: "Invalid organization" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )

      const result = await parseZohoResponse(response, "/journals")

      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.errorMessage).toContain("Invalid organization")
    })

    it("handles HTTP error with JSON body", async () => {
      const response = new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      })

      const result = await parseZohoResponse(response, "/journals")

      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
    })

    it("handles HTTP error with non-JSON body", async () => {
      const response = new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      })

      const result = await parseZohoResponse(response, "/journals")

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("500")
      expect(result.error?.category).toBe("server")
    })

    it("handles successful non-JSON response as error", async () => {
      const response = new Response("OK", {
        status: 200,
      })

      const result = await parseZohoResponse(response)

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("non-JSON")
    })

    it("handles non-JSON error response with 4xx status", async () => {
      const response = new Response("Bad Request", {
        status: 400,
        statusText: "Bad Request",
      })

      const result = await parseZohoResponse(response, "/test")

      expect(result.ok).toBe(false)
      expect(result.error?.category).toBe("unknown")
    })
  })

  describe("extractData", () => {
    it("extracts data for valid whitelisted key", () => {
      const response = { journal: { id: "123" }, code: 0 }
      const result = extractData<{ id: string }>(response, "journal")

      expect(result).toEqual({ id: "123" })
    })

    it("returns undefined for missing key", () => {
      const response = { code: 0 }
      const result = extractData<{ id: string }>(response, "journal")

      expect(result).toBeUndefined()
    })

    it("throws error for non-whitelisted key", () => {
      const response = { secret: "password", code: 0 }

      expect(() => extractData(response, "secret")).toThrow("Non-whitelisted response key")
    })

    it("sanitizes malicious key in error message", () => {
      const response = { code: 0 }

      expect(() => extractData(response, "evil\nkey\rinjection")).toThrow(
        "Non-whitelisted response key: evilkeyinjection"
      )
    })

    it("truncates long keys in error message", () => {
      const response = { code: 0 }
      const longKey = "a".repeat(100)

      expect(() => extractData(response, longKey)).toThrow(/^Non-whitelisted response key: a{50}$/)
    })

    it("extracts data for all valid keys", () => {
      const validKeys = [
        "organization",
        "organizations",
        "journal",
        "journals",
        "expense",
        "expenses",
        "bill",
        "bills",
        "invoice",
        "invoices",
        "contact",
        "contacts",
        "bankaccount",
        "bankaccounts",
        "banktransaction",
        "banktransactions",
        "chartofaccount",
        "chartofaccounts",
        "attachment",
        "documents",
        "page_context",
        "message",
        "code",
      ]

      for (const key of validKeys) {
        const response = { [key]: "test-value" }
        expect(() => extractData(response, key)).not.toThrow()
        expect(extractData(response, key)).toBe("test-value")
      }
    })
  })

  describe("formatSuccessMessage", () => {
    it("formats message without details", () => {
      const result = formatSuccessMessage("Created journal")

      expect(result).toBe("**Success**: Created journal")
    })

    it("formats message with details", () => {
      const result = formatSuccessMessage("Created journal", "ID: 123")

      expect(result).toBe("**Success**: Created journal\nID: 123")
    })
  })

  describe("formatListResponse", () => {
    it("returns empty message for empty list", () => {
      const result = formatListResponse([], (item) => item.toString())

      expect(result).toBe("No items found")
    })

    it("returns custom empty message", () => {
      const result = formatListResponse([], (item) => item.toString(), "Nothing here")

      expect(result).toBe("Nothing here")
    })

    it("formats list items", () => {
      const items = [{ name: "Item 1" }, { name: "Item 2" }]
      const result = formatListResponse(items, (item, index) => `${index + 1}. ${item.name}`)

      expect(result).toBe("1. Item 1\n\n2. Item 2")
    })
  })
})
