/**
 * Tests for validation utilities
 */

import { describe, it, expect } from "vitest"
import {
  dateSchema,
  optionalDateSchema,
  moneySchema,
  moneyOrZeroSchema,
  organizationIdSchema,
  optionalOrganizationIdSchema,
  entityIdSchema,
  isValidDateFormat,
  isValidMoney,
} from "../../utils/validation.js"

describe("Validation Utilities", () => {
  describe("dateSchema", () => {
    it("accepts valid date", () => {
      expect(dateSchema.safeParse("2024-01-15").success).toBe(true)
    })

    it("accepts leap year date", () => {
      expect(dateSchema.safeParse("2024-02-29").success).toBe(true)
    })

    it("rejects invalid format", () => {
      expect(dateSchema.safeParse("01-15-2024").success).toBe(false)
      expect(dateSchema.safeParse("2024/01/15").success).toBe(false)
      expect(dateSchema.safeParse("2024-1-15").success).toBe(false)
    })

    it("rejects impossible dates", () => {
      expect(dateSchema.safeParse("2024-02-31").success).toBe(false)
      expect(dateSchema.safeParse("2024-13-01").success).toBe(false)
      expect(dateSchema.safeParse("2023-02-29").success).toBe(false) // not a leap year
    })

    it("rejects non-date strings", () => {
      expect(dateSchema.safeParse("not-a-date").success).toBe(false)
      expect(dateSchema.safeParse("").success).toBe(false)
    })
  })

  describe("optionalDateSchema", () => {
    it("accepts valid date", () => {
      expect(optionalDateSchema.safeParse("2024-01-15").success).toBe(true)
    })

    it("accepts undefined", () => {
      expect(optionalDateSchema.safeParse(undefined).success).toBe(true)
    })

    it("rejects invalid date", () => {
      expect(optionalDateSchema.safeParse("invalid").success).toBe(false)
    })
  })

  describe("moneySchema", () => {
    it("accepts valid amounts", () => {
      expect(moneySchema.safeParse(100).success).toBe(true)
      expect(moneySchema.safeParse(0.01).success).toBe(true)
      expect(moneySchema.safeParse(999999999.99).success).toBe(true)
      expect(moneySchema.safeParse(123.45).success).toBe(true)
    })

    it("rejects zero", () => {
      expect(moneySchema.safeParse(0).success).toBe(false)
    })

    it("rejects negative amounts", () => {
      expect(moneySchema.safeParse(-1).success).toBe(false)
      expect(moneySchema.safeParse(-0.01).success).toBe(false)
    })

    it("rejects amounts exceeding maximum", () => {
      expect(moneySchema.safeParse(1000000000).success).toBe(false)
    })

    it("rejects amounts with more than 2 decimal places", () => {
      expect(moneySchema.safeParse(1.234).success).toBe(false)
      expect(moneySchema.safeParse(0.001).success).toBe(false)
    })

    it("rejects non-finite values", () => {
      expect(moneySchema.safeParse(Infinity).success).toBe(false)
      expect(moneySchema.safeParse(NaN).success).toBe(false)
    })
  })

  describe("moneyOrZeroSchema", () => {
    it("accepts zero", () => {
      expect(moneyOrZeroSchema.safeParse(0).success).toBe(true)
    })

    it("accepts positive amounts", () => {
      expect(moneyOrZeroSchema.safeParse(100).success).toBe(true)
      expect(moneyOrZeroSchema.safeParse(0.01).success).toBe(true)
    })

    it("rejects negative amounts", () => {
      expect(moneyOrZeroSchema.safeParse(-1).success).toBe(false)
    })

    it("rejects amounts with more than 2 decimal places", () => {
      expect(moneyOrZeroSchema.safeParse(1.234).success).toBe(false)
    })
  })

  describe("organizationIdSchema", () => {
    it("accepts valid organization IDs", () => {
      expect(organizationIdSchema.safeParse("org123").success).toBe(true)
      expect(organizationIdSchema.safeParse("org-123").success).toBe(true)
      expect(organizationIdSchema.safeParse("org_123").success).toBe(true)
      expect(organizationIdSchema.safeParse("ORG123").success).toBe(true)
    })

    it("rejects invalid characters", () => {
      expect(organizationIdSchema.safeParse("org 123").success).toBe(false)
      expect(organizationIdSchema.safeParse("org@123").success).toBe(false)
      expect(organizationIdSchema.safeParse("org/123").success).toBe(false)
    })

    it("rejects too long IDs", () => {
      const longId = "a".repeat(51)
      expect(organizationIdSchema.safeParse(longId).success).toBe(false)
    })

    it("rejects empty string", () => {
      expect(organizationIdSchema.safeParse("").success).toBe(false)
    })
  })

  describe("optionalOrganizationIdSchema", () => {
    it("accepts valid organization ID", () => {
      expect(optionalOrganizationIdSchema.safeParse("org123").success).toBe(true)
    })

    it("accepts undefined", () => {
      expect(optionalOrganizationIdSchema.safeParse(undefined).success).toBe(true)
    })

    it("rejects invalid organization ID", () => {
      expect(optionalOrganizationIdSchema.safeParse("org@123").success).toBe(false)
    })
  })

  describe("entityIdSchema", () => {
    it("accepts valid entity IDs", () => {
      expect(entityIdSchema.safeParse("journal123").success).toBe(true)
      expect(entityIdSchema.safeParse("expense-456").success).toBe(true)
      expect(entityIdSchema.safeParse("bill_789").success).toBe(true)
    })

    it("rejects invalid characters", () => {
      expect(entityIdSchema.safeParse("id with space").success).toBe(false)
      expect(entityIdSchema.safeParse("id@special").success).toBe(false)
    })

    it("rejects too long IDs", () => {
      const longId = "a".repeat(51)
      expect(entityIdSchema.safeParse(longId).success).toBe(false)
    })
  })

  describe("isValidDateFormat", () => {
    it("returns true for valid dates", () => {
      expect(isValidDateFormat("2024-01-15")).toBe(true)
      expect(isValidDateFormat("2024-02-29")).toBe(true)
      expect(isValidDateFormat("2000-12-31")).toBe(true)
    })

    it("returns false for invalid format", () => {
      expect(isValidDateFormat("01-15-2024")).toBe(false)
      expect(isValidDateFormat("2024/01/15")).toBe(false)
      expect(isValidDateFormat("2024-1-15")).toBe(false)
    })

    it("returns false for impossible dates", () => {
      expect(isValidDateFormat("2024-02-31")).toBe(false)
      expect(isValidDateFormat("2024-13-01")).toBe(false)
      expect(isValidDateFormat("2023-02-29")).toBe(false)
    })

    it("returns false for non-date strings", () => {
      expect(isValidDateFormat("not-a-date")).toBe(false)
      expect(isValidDateFormat("")).toBe(false)
    })
  })

  describe("isValidMoney", () => {
    it("returns true for valid amounts", () => {
      expect(isValidMoney(100)).toBe(true)
      expect(isValidMoney(0.01)).toBe(true)
      expect(isValidMoney(999999999.99)).toBe(true)
      expect(isValidMoney(123.45)).toBe(true)
    })

    it("returns false for zero", () => {
      expect(isValidMoney(0)).toBe(false)
    })

    it("returns false for negative amounts", () => {
      expect(isValidMoney(-1)).toBe(false)
    })

    it("returns false for amounts exceeding maximum", () => {
      expect(isValidMoney(1000000000)).toBe(false)
    })

    it("returns false for amounts with more than 2 decimal places", () => {
      expect(isValidMoney(1.234)).toBe(false)
    })

    it("returns false for non-finite values", () => {
      expect(isValidMoney(Infinity)).toBe(false)
      expect(isValidMoney(NaN)).toBe(false)
    })
  })
})
