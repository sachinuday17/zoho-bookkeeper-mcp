/**
 * Tests for Zoho Books API Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import {
  zohoRequest,
  zohoGet,
  zohoPost,
  zohoPut,
  zohoDelete,
  zohoUploadAttachment,
  zohoGetAttachment,
  zohoDeleteAttachment,
  zohoListOrganizations,
} from "../../api/client.js"

// Mock dependencies
vi.mock("../../auth/oauth.js", () => ({
  getAccessToken: vi.fn(),
  ZohoAuthError: class ZohoAuthError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "ZohoAuthError"
    }
  },
}))

vi.mock("../../config.js", () => ({
  getZohoConfig: vi.fn(() => ({
    clientId: "test-client-id",
    clientSecret: "test-secret",
    refreshToken: "test-refresh",
    apiUrl: "https://api.zoho.com/books/v3",
    organizationId: "",
  })),
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  REQUEST_TIMEOUT_MS: 30000,
}))

// Import mocked modules
import { getAccessToken, ZohoAuthError } from "../../auth/oauth.js"
import { getZohoConfig } from "../../config.js"

const mockGetAccessToken = vi.mocked(getAccessToken)
const mockGetZohoConfig = vi.mocked(getZohoConfig)

describe("Zoho API Client", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAccessToken.mockResolvedValue("test-access-token")
    mockGetZohoConfig.mockReturnValue({
      clientId: "test-client-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
      apiUrl: "https://api.zoho.com/books/v3",
      organizationId: "default-org-123",
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("zohoRequest", () => {
    it("makes successful GET request", async () => {
      const mockResponse = { code: 0, journal: { id: "123" } }
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )

      const result = await zohoRequest("GET", "/journals/123", "org-123")

      expect(result.ok).toBe(true)
      expect(result.data).toEqual(mockResponse)
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/journals/123"),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Zoho-oauthtoken test-access-token",
          }),
        })
      )
    })

    it("makes successful POST request with body", async () => {
      const mockResponse = { code: 0, journal: { id: "123" } }
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )

      const body = { journal_date: "2024-01-15", notes: "Test" }
      const result = await zohoRequest("POST", "/journals", "org-123", body)

      expect(result.ok).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("JSONString"),
        })
      )
    })

    it("includes query params in URL", async () => {
      const mockResponse = { code: 0, journals: [] }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      await zohoRequest("GET", "/journals", "org-123", undefined, {
        page: "1",
        per_page: "25",
      })

      const callUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(callUrl).toContain("page=1")
      expect(callUrl).toContain("per_page=25")
      expect(callUrl).toContain("organization_id=org-123")
    })

    it("returns error when organization ID is missing", async () => {
      mockGetZohoConfig.mockReturnValue({
        clientId: "test",
        clientSecret: "test",
        refreshToken: "test",
        apiUrl: "https://api.zoho.com/books/v3",
        organizationId: "", // No default org
      })

      const result = await zohoRequest("GET", "/journals", undefined)

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("Organization ID required")
    })

    it("uses default organization ID from config", async () => {
      const mockResponse = { code: 0, journals: [] }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      await zohoRequest("GET", "/journals")

      const callUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(callUrl).toContain("organization_id=default-org-123")
    })

    it("handles authentication error", async () => {
      mockGetAccessToken.mockRejectedValue(new ZohoAuthError("Token expired"))

      const result = await zohoRequest("GET", "/journals", "org-123")

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toBe("Token expired")
    })

    it("handles generic authentication error", async () => {
      mockGetAccessToken.mockRejectedValue(new Error("Network error"))

      const result = await zohoRequest("GET", "/journals", "org-123")

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("Authentication error")
      expect(result.errorMessage).toContain("Network error")
    })

    it("handles request timeout", async () => {
      const abortError = new Error("Aborted")
      abortError.name = "AbortError"
      global.fetch = vi.fn().mockRejectedValue(abortError)

      const result = await zohoRequest("GET", "/journals", "org-123")

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("timeout")
    })

    it("handles network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network unreachable"))

      const result = await zohoRequest("GET", "/journals", "org-123")

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("Request failed")
      expect(result.errorMessage).toContain("Network unreachable")
    })

    it("handles Zoho API error response", async () => {
      const errorResponse = { code: 1002, message: "Invalid organization" }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(errorResponse), { status: 200 }))

      const result = await zohoRequest("GET", "/journals", "org-123")

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("Invalid organization")
    })
  })

  describe("zohoGet", () => {
    it("calls zohoRequest with GET method", async () => {
      const mockResponse = { code: 0, journals: [] }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      const result = await zohoGet("/journals", "org-123", { page: "1" })

      expect(result.ok).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "GET" })
      )
    })
  })

  describe("zohoPost", () => {
    it("calls zohoRequest with POST method", async () => {
      const mockResponse = { code: 0, journal: { id: "123" } }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      const result = await zohoPost("/journals", "org-123", { notes: "Test" })

      expect(result.ok).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "POST" })
      )
    })
  })

  describe("zohoPut", () => {
    it("calls zohoRequest with PUT method", async () => {
      const mockResponse = { code: 0, journal: { id: "123" } }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      const result = await zohoPut("/journals/123", "org-123", { notes: "Updated" })

      expect(result.ok).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "PUT" })
      )
    })
  })

  describe("zohoDelete", () => {
    it("calls zohoRequest with DELETE method", async () => {
      const mockResponse = { code: 0, message: "Deleted" }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      const result = await zohoDelete("/journals/123", "org-123")

      expect(result.ok).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "DELETE" })
      )
    })
  })

  describe("zohoGetAttachment", () => {
    it("calls zohoGet for attachment endpoint", async () => {
      const mockResponse = { code: 0, documents: [] }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      const result = await zohoGetAttachment("/journals/123/attachment", "org-123")

      expect(result.ok).toBe(true)
    })
  })

  describe("zohoDeleteAttachment", () => {
    it("calls zohoDelete for attachment endpoint", async () => {
      const mockResponse = { code: 0, message: "Deleted" }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      const result = await zohoDeleteAttachment("/journals/123/attachment", "org-123")

      expect(result.ok).toBe(true)
    })
  })

  describe("zohoListOrganizations", () => {
    it("lists organizations without organization_id param", async () => {
      const mockResponse = { code: 0, organizations: [{ organization_id: "org-1" }] }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      const result = await zohoListOrganizations()

      expect(result.ok).toBe(true)
      expect(result.data).toEqual(mockResponse)

      const callUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(callUrl).toContain("/organizations")
      expect(callUrl).not.toContain("organization_id")
    })

    it("handles authentication error", async () => {
      mockGetAccessToken.mockRejectedValue(new ZohoAuthError("Invalid token"))

      const result = await zohoListOrganizations()

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toBe("Invalid token")
    })

    it("handles generic auth error", async () => {
      mockGetAccessToken.mockRejectedValue(new Error("Network error"))

      const result = await zohoListOrganizations()

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("Authentication error")
    })

    it("handles timeout", async () => {
      const abortError = new Error("Aborted")
      abortError.name = "AbortError"
      global.fetch = vi.fn().mockRejectedValue(abortError)

      const result = await zohoListOrganizations()

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("timeout")
    })

    it("handles network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"))

      const result = await zohoListOrganizations()

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("Request failed")
    })
  })

  describe("zohoUploadAttachment", () => {
    const testUploadDir = "/tmp/zoho-bookkeeper-uploads"
    const testFilePath = path.join(testUploadDir, "test-file.pdf")

    beforeEach(() => {
      // Create test directory and file
      if (!fs.existsSync(testUploadDir)) {
        fs.mkdirSync(testUploadDir, { recursive: true })
      }
      fs.writeFileSync(testFilePath, "test content")
    })

    afterEach(() => {
      // Clean up test file
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath)
      }
    })

    it("uploads file successfully", async () => {
      const mockResponse = { code: 0, message: "Attachment added" }
      global.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200 }))

      const result = await zohoUploadAttachment("/journals/123/attachment", "org-123", testFilePath)

      expect(result.ok).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/journals/123/attachment"),
        expect.objectContaining({
          method: "POST",
          body: expect.any(FormData),
        })
      )
    })

    it("rejects file outside allowed directories", async () => {
      const result = await zohoUploadAttachment(
        "/journals/123/attachment",
        "org-123",
        "/etc/passwd"
      )

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("not in allowed upload directories")
    })

    it("rejects path traversal attempts", async () => {
      const result = await zohoUploadAttachment(
        "/journals/123/attachment",
        "org-123",
        "/tmp/zoho-bookkeeper-uploads/../../../etc/passwd"
      )

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("not in allowed upload directories")
    })

    it("rejects invalid file extensions", async () => {
      const invalidFile = path.join(testUploadDir, "test.exe")
      fs.writeFileSync(invalidFile, "test")

      try {
        const result = await zohoUploadAttachment(
          "/journals/123/attachment",
          "org-123",
          invalidFile
        )

        expect(result.ok).toBe(false)
        expect(result.errorMessage).toContain("Unsupported file type")
      } finally {
        fs.unlinkSync(invalidFile)
      }
    })

    it("handles non-existent file", async () => {
      // Non-existent file may fail at path validation (if dir doesn't exist)
      // or at file open (if dir exists but file doesn't)
      const result = await zohoUploadAttachment(
        "/journals/123/attachment",
        "org-123",
        path.join(testUploadDir, "non-existent.pdf")
      )

      expect(result.ok).toBe(false)
      // Either "not in allowed upload directories" or "File not found or inaccessible"
      expect(
        result.errorMessage?.includes("not in allowed upload directories") ||
          result.errorMessage?.includes("File not found")
      ).toBe(true)
    })

    it("returns error when organization ID is missing", async () => {
      mockGetZohoConfig.mockReturnValue({
        clientId: "test",
        clientSecret: "test",
        refreshToken: "test",
        apiUrl: "https://api.zoho.com/books/v3",
        organizationId: "",
      })

      const result = await zohoUploadAttachment("/journals/123/attachment", undefined, testFilePath)

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("Organization ID required")
    })

    it("handles authentication error", async () => {
      mockGetAccessToken.mockRejectedValue(new ZohoAuthError("Token invalid"))

      const result = await zohoUploadAttachment("/journals/123/attachment", "org-123", testFilePath)

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toBe("Token invalid")
    })

    it("handles upload timeout", async () => {
      const abortError = new Error("Aborted")
      abortError.name = "AbortError"
      global.fetch = vi.fn().mockRejectedValue(abortError)

      const result = await zohoUploadAttachment("/journals/123/attachment", "org-123", testFilePath)

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("timeout")
    })

    it("handles upload network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Upload failed"))

      const result = await zohoUploadAttachment("/journals/123/attachment", "org-123", testFilePath)

      expect(result.ok).toBe(false)
      expect(result.errorMessage).toContain("Upload failed")
    })

    it("rejects directories", async () => {
      const dirPath = path.join(testUploadDir, "subdir")
      fs.mkdirSync(dirPath, { recursive: true })

      try {
        const result = await zohoUploadAttachment("/journals/123/attachment", "org-123", dirPath)

        expect(result.ok).toBe(false)
        // Should fail either at extension validation or isFile check
        expect(result.ok).toBe(false)
      } finally {
        fs.rmdirSync(dirPath)
      }
    })
  })
})
