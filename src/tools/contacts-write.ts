/**
 * Contact Write Tools — Zoho Books India
 *
 * Security controls:
 * - GSTIN validated: 15-char regex before saving
 * - PAN validated: 10-char regex before saving
 * - place_of_supply: 2-digit state code regex
 * - Email validated: RFC-compliant via zod
 * - Audit log on all writes
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"
import {
  gstinSchema,
  panSchema,
  placeOfSupplySchema,
  gstTreatmentSchema,
  auditStart,
  auditSuccess,
  auditFail,
} from "../utils/validators.js"

const addressSchema = z.object({
  attention: z.string().max(200).optional(),
  address: z.string().max(500).optional().describe("Street address"),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional().describe("State name (full name, not code)"),
  zip: z.string().regex(/^[0-9]{6}$/, "PIN code must be 6 digits").optional(),
  country: z.string().max(100).optional().describe("Country (default: India)"),
})

export function registerContactWriteTools(server: FastMCP): void {

  // ─── Create Contact ──────────────────────────────────────────────────────

  server.addTool({
    name: "create_contact",
    description: `Create a new customer or vendor contact in Zoho Books.
GSTIN and PAN are validated against official formats before saving.
place_of_supply is required for correct inter/intra-state GST determination.
For export customers, set gst_treatment=overseas and omit place_of_supply.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      contact_name: z.string().min(2).max(200).describe("Contact/company display name"),
      contact_type: z.enum(["customer", "vendor"]),
      company_name: z.string().max(200).optional(),
      email: z.string().email().optional(),
      phone: z.string().max(20).optional(),
      mobile: z.string().max(20).optional(),
      gstin: gstinSchema.describe("GSTIN — validated 15-char format (e.g. 29AABCT1332L1ZS)"),
      gst_treatment: gstTreatmentSchema.optional(),
      place_of_supply: z.string().regex(/^(0[1-9]|[1-2][0-9]|3[0-8])$/, "2-digit state code").optional(),
      pan_number: panSchema.describe("PAN — validated 10-char format (e.g. ABCDE1234F). Required for TDS deduction."),
      billing_address: addressSchema.optional(),
      shipping_address: addressSchema.optional(),
      payment_terms: z.number().int().min(0).max(365).optional().describe("Net payment days (e.g. 30 for net-30)"),
      notes: z.string().max(2000).optional().describe("Internal notes — not visible on transactions"),
    }),
    annotations: { title: "Create Contact", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // Business rule: GST-registered contacts must have place_of_supply
      if (args.gst_treatment === "business_gst" && !args.place_of_supply) {
        return "place_of_supply is required for GST-registered contacts (gst_treatment=business_gst). Provide the 2-digit state code."
      }

      auditStart("create_contact", args.organization_id, "WRITE", "contact", args)
      const payload: Record<string, unknown> = {
        contact_name: args.contact_name,
        contact_type: args.contact_type,
      }
      if (args.company_name) payload.company_name = args.company_name
      if (args.email) payload.email = args.email
      if (args.phone) payload.phone = args.phone
      if (args.mobile) payload.mobile = args.mobile
      if (args.gstin) payload.gstin = args.gstin
      if (args.gst_treatment) payload.gst_treatment = args.gst_treatment
      if (args.place_of_supply) payload.place_of_supply = args.place_of_supply
      if (args.pan_number) payload.pan_number = args.pan_number
      if (args.billing_address) payload.billing_address = args.billing_address
      if (args.shipping_address) payload.shipping_address = args.shipping_address
      if (args.payment_terms !== undefined) payload.payment_terms = args.payment_terms
      if (args.notes) payload.notes = args.notes

      const result = await zohoPost<{ contact: any }>("/contacts", args.organization_id, payload)
      if (!result.ok) {
        auditFail("create_contact", args.organization_id, "WRITE", "contact", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to create contact"
      }
      const c = result.data?.contact
      auditSuccess("create_contact", args.organization_id, "WRITE", "contact", c?.contact_id)
      return `**Contact Created**\n\n- Contact ID: \`${c?.contact_id}\`\n- Name: ${c?.contact_name}\n- Type: ${c?.contact_type}\n- GSTIN: ${c?.gstin || "N/A"}\n- PAN: ${c?.pan_number ? "Saved" : "N/A"}\n- Email: ${c?.email || "N/A"}`
    },
  })

  // ─── Update Contact ──────────────────────────────────────────────────────

  server.addTool({
    name: "update_contact",
    description: `Update an existing contact in Zoho Books.
Provide only fields that need changing — other fields are preserved.
GSTIN and PAN are re-validated on update.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      contact_id: z.string().min(1),
      contact_name: z.string().min(2).max(200).optional(),
      email: z.string().email().optional(),
      phone: z.string().max(20).optional(),
      gstin: gstinSchema,
      gst_treatment: gstTreatmentSchema.optional(),
      place_of_supply: z.string().regex(/^(0[1-9]|[1-2][0-9]|3[0-8])$/).optional(),
      pan_number: panSchema,
      payment_terms: z.number().int().min(0).max(365).optional(),
      billing_address: addressSchema.optional(),
      notes: z.string().max(2000).optional(),
    }),
    annotations: { title: "Update Contact", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("update_contact", args.organization_id, "WRITE", "contact", args)
      const payload: Record<string, unknown> = {}
      if (args.contact_name) payload.contact_name = args.contact_name
      if (args.email) payload.email = args.email
      if (args.phone) payload.phone = args.phone
      if (args.gstin) payload.gstin = args.gstin
      if (args.gst_treatment) payload.gst_treatment = args.gst_treatment
      if (args.place_of_supply) payload.place_of_supply = args.place_of_supply
      if (args.pan_number) payload.pan_number = args.pan_number
      if (args.payment_terms !== undefined) payload.payment_terms = args.payment_terms
      if (args.billing_address) payload.billing_address = args.billing_address
      if (args.notes) payload.notes = args.notes

      const result = await zohoPost<{ contact: any }>(
        `/contacts/${args.contact_id}`, args.organization_id, payload
      )
      if (!result.ok) {
        auditFail("update_contact", args.organization_id, "WRITE", "contact", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to update contact"
      }
      auditSuccess("update_contact", args.organization_id, "WRITE", "contact", args.contact_id)
      return `**Contact Updated**\n\n- Contact ID: \`${args.contact_id}\`\n- Name: ${result.data?.contact?.contact_name}`
    },
  })

  // ─── Set Contact Status ──────────────────────────────────────────────────

  server.addTool({
    name: "set_contact_status",
    description: `Mark a contact as active or inactive.
Inactive contacts are hidden from transaction entry dropdowns but all history is preserved.
Use instead of deleting — deletion removes audit trail.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      contact_id: z.string().min(1),
      status: z.enum(["active", "inactive"]),
    }),
    annotations: { title: "Set Contact Status", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("set_contact_status", args.organization_id, "WRITE", "contact", args)
      const result = await zohoPost<{ message: string }>(
        `/contacts/${args.contact_id}/status/${args.status}`, args.organization_id, {}
      )
      if (!result.ok) {
        auditFail("set_contact_status", args.organization_id, "WRITE", "contact", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to update contact status"
      }
      auditSuccess("set_contact_status", args.organization_id, "WRITE", "contact", args.contact_id)
      return `**Contact ${args.status === "inactive" ? "Deactivated" : "Activated"}**\n\n- Contact ID: \`${args.contact_id}\`\n- Status: ${args.status}`
    },
  })

  // ─── Get Contact Statement ───────────────────────────────────────────────

  server.addTool({
    name: "get_contact_statement",
    description: `Get account statement (debtor/creditor ledger) for a contact.
Returns all transactions: invoices, payments, credit notes, advances.
Use for collections follow-up, payment reconciliation, and debtor review.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      contact_id: z.string().min(1),
      date_start: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_end: z.string().optional().describe("End date (YYYY-MM-DD)"),
    }),
    annotations: { title: "Contact Statement", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end

      const result = await zohoGet<{ statement: any }>(
        `/contacts/${args.contact_id}/statements`, args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to get contact statement"
      const stmt = result.data?.statement
      const txns = stmt?.transactions || []

      if (txns.length === 0) return `No transactions found for contact \`${args.contact_id}\` in the specified period.`

      const formatted = txns.slice(0, 20).map((tx: any, i: number) =>
        `${i + 1}. ${tx.date} | ${tx.transaction_type} | INR ${tx.amount} | Balance: INR ${tx.balance || 0}`
      ).join("\n")

      return `**Contact Statement**\n\n- Contact ID: \`${args.contact_id}\`\n- Opening Balance: INR ${Number(stmt?.opening_balance || 0).toLocaleString("en-IN")}\n- Closing Balance: INR ${Number(stmt?.closing_balance || 0).toLocaleString("en-IN")}\n- Transactions: ${txns.length}\n\n**Recent Entries (up to 20):**\n${formatted}${txns.length > 20 ? `\n...and ${txns.length - 20} more.` : ""}`
    },
  })
}
