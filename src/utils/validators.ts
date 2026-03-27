/**
 * Shared validation schemas and audit utilities
 * CA-grade: all financial inputs validated before touching Zoho API
 */

import { z } from "zod"

// ─── India Tax Validators ────────────────────────────────────────────────────

export const gstinSchema = z
  .string()
  .regex(
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
    "Invalid GSTIN. Must be 15-char alphanumeric (e.g. 29AABCT1332L1ZS)"
  )
  .optional()

export const panSchema = z
  .string()
  .regex(
    /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/,
    "Invalid PAN. Must be 10-char (e.g. ABCDE1234F)"
  )
  .optional()

export const placeOfSupplySchema = z
  .string()
  .regex(
    /^(0[1-9]|[1-2][0-9]|3[0-8])$/,
    "Must be 2-digit state code (01–38). e.g. 29=Karnataka, 27=Maharashtra, 07=Delhi, 36=Telangana"
  )
  .describe("GST place of supply — 2-digit state code. MANDATORY for correct IGST/CGST/SGST split.")

export const gstReturnPeriodSchema = z
  .string()
  .regex(
    /^(0[1-9]|1[0-2])[0-9]{4}$/,
    "Format must be MMYYYY (e.g. 032026 for March 2026, 042026 for April 2026)"
  )

export const gstTreatmentSchema = z
  .enum(["business_gst", "business_none", "overseas", "consumer"])
  .describe("GST treatment: business_gst=Registered, business_none=Unregistered, overseas=Export, consumer=B2C")

// ─── Date Validators ─────────────────────────────────────────────────────────

export const dateSchema = z
  .string()
  .regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, "Date must be YYYY-MM-DD")

export const optionalDateSchema = dateSchema.optional()

// ─── Amount Validators ────────────────────────────────────────────────────────

export const positiveAmountSchema = z
  .number()
  .positive("Amount must be greater than zero")
  .max(999_999_999, "Amount exceeds maximum allowed (₹99,99,99,999)")
  .multipleOf(0.01, "Amount cannot have more than 2 decimal places")

// ─── Irreversible Operation Guard ─────────────────────────────────────────────

export const confirmIrreversibleSchema = z
  .literal(true, {
    errorMap: () => ({
      message:
        "This action is IRREVERSIBLE. Set confirm: true to proceed. " +
        "Verify the ID before confirming — this cannot be undone.",
    }),
  })
  .describe("REQUIRED: Must explicitly pass true. Action cannot be undone.")

// ─── Audit Logger ─────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string
  tool: string
  organization_id: string
  action_type: "READ" | "WRITE" | "DELETE" | "VOID"
  entity_type: string
  entity_id?: string
  param_keys: string[]      // log param names only — never values (no credential leak)
  status: "INITIATED" | "SUCCESS" | "FAILED"
  error?: string
}

export function auditLog(entry: AuditEntry): void {
  // Structured JSON log — Railway captures stdout to log stream
  // In production: replace with winston/pino and ship to CloudWatch/Datadog
  console.log(JSON.stringify({ audit: true, ...entry }))
}

export function auditStart(
  tool: string,
  org: string | undefined,
  actionType: AuditEntry["action_type"],
  entityType: string,
  args: Record<string, unknown>
): void {
  auditLog({
    timestamp: new Date().toISOString(),
    tool,
    organization_id: org || "ENV_DEFAULT",
    action_type: actionType,
    entity_type: entityType,
    param_keys: Object.keys(args),
    status: "INITIATED",
  })
}

export function auditSuccess(
  tool: string,
  org: string | undefined,
  actionType: AuditEntry["action_type"],
  entityType: string,
  entityId?: string
): void {
  auditLog({
    timestamp: new Date().toISOString(),
    tool,
    organization_id: org || "ENV_DEFAULT",
    action_type: actionType,
    entity_type: entityType,
    entity_id: entityId,
    param_keys: [],
    status: "SUCCESS",
  })
}

export function auditFail(
  tool: string,
  org: string | undefined,
  actionType: AuditEntry["action_type"],
  entityType: string,
  error: string
): void {
  auditLog({
    timestamp: new Date().toISOString(),
    tool,
    organization_id: org || "ENV_DEFAULT",
    action_type: actionType,
    entity_type: entityType,
    param_keys: [],
    status: "FAILED",
    error,
  })
}
