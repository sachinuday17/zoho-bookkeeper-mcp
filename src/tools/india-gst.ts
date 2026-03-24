/**
 * India GST / e-Invoice / e-Way Bill / TDS Tools — Zoho Books
 *
 * Security controls:
 * - e-Invoice cancellation: 24-hour IRP window check before attempting
 * - GSTR return period: MMYYYY regex validation
 * - e-Way Bill: transportation mode enum-locked
 * - Confirm guard on irreversible GST operations
 * - Audit log on all writes
 *
 * Compliance note:
 * - e-Invoice mandatory for B2B above ₹5Cr annual turnover (FY 2023-24 onwards)
 * - e-Way Bill mandatory for goods movement > ₹50,000
 * - GSTR-1 filing due: 11th of following month (monthly) or 13th (quarterly QRMP)
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"
import {
  gstReturnPeriodSchema,
  dateSchema,
  confirmIrreversibleSchema,
  auditStart,
  auditSuccess,
  auditFail,
} from "../utils/validators.js"

export function registerIndiaGSTTools(server: FastMCP): void {

  // ─── Generate e-Invoice (IRN) ────────────────────────────────────────────

  server.addTool({
    name: "generate_einvoice",
    description: `Generate an e-Invoice (IRN) for a sales invoice under India GST.
Pushes invoice to IRP (Invoice Registration Portal) and returns IRN + signed QR code.
Requirements: invoice must be Open/Sent, customer must have valid GSTIN,
place_of_supply must be set, HSN/SAC codes required on all line items.
Mandatory for B2B invoices if annual turnover > ₹5 Crore.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1).describe("Invoice ID — must be Open or Sent status"),
    }),
    annotations: { title: "Generate e-Invoice (IRN)", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // Pre-check: verify invoice is in correct status
      const check = await zohoGet<{ invoice: any }>(`/invoices/${args.invoice_id}`, args.organization_id)
      if (!check.ok) return check.errorMessage || "Could not fetch invoice"
      const inv = check.data?.invoice
      if (!inv) return "Invoice not found"
      if (!["open", "sent", "partially_paid"].includes(inv.status?.toLowerCase())) {
        return `Invoice status is "${inv.status}" — e-Invoice can only be generated for Open/Sent invoices.`
      }
      if (!inv.place_of_supply) {
        return "Invoice is missing place_of_supply. Update the invoice to add a 2-digit state code before generating IRN."
      }

      auditStart("generate_einvoice", args.organization_id, "WRITE", "einvoice", args)
      const result = await zohoPost<{ einvoice: any }>(
        `/invoices/${args.invoice_id}/einvoice/generate`, args.organization_id, {}
      )
      if (!result.ok) {
        auditFail("generate_einvoice", args.organization_id, "WRITE", "einvoice", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to generate e-Invoice"
      }
      const ei = result.data?.einvoice
      auditSuccess("generate_einvoice", args.organization_id, "WRITE", "einvoice", ei?.irn)
      return `**e-Invoice Generated**\n\n- Invoice ID: \`${args.invoice_id}\`\n- IRN: ${ei?.irn || "N/A"}\n- ACK No: ${ei?.ack_no || "N/A"}\n- ACK Date: ${ei?.ack_date || "N/A"}\n- Status: ${ei?.einvoice_status || "N/A"}\n\n⚠️ IRN cancellation window: 24 hours from ACK date.`
    },
  })

  // ─── Cancel e-Invoice ────────────────────────────────────────────────────

  server.addTool({
    name: "cancel_einvoice",
    description: `Cancel a previously generated e-Invoice (IRN) — IRREVERSIBLE.
CRITICAL: IRP allows cancellation ONLY within 24 hours of IRN generation.
After 24 hours: issue a Credit Note instead — do not attempt IRN cancellation.
This tool automatically checks the 24-hour window before proceeding.
Set confirm: true to proceed.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1),
      cancel_reason: z.enum(["1", "2", "3", "4"]).describe(
        "IRP reason code: 1=Duplicate, 2=Data Entry Error, 3=Order Cancelled, 4=Other"
      ),
      cancel_remarks: z.string().max(100).optional().describe("Cancellation remarks (max 100 chars)"),
      confirm: confirmIrreversibleSchema,
    }),
    annotations: { title: "Cancel e-Invoice", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // CRITICAL: Check 24-hour IRP cancellation window
      const check = await zohoGet<{ invoice: any }>(`/invoices/${args.invoice_id}`, args.organization_id)
      if (!check.ok) return check.errorMessage || "Could not fetch invoice"

      const einvoiceDetails = check.data?.invoice?.einvoice_details?.[0]
      if (!einvoiceDetails) {
        return `Invoice \`${args.invoice_id}\` does not have an active IRN. Nothing to cancel.`
      }

      const ackDate = einvoiceDetails.ack_date
      if (ackDate) {
        const ackTime = new Date(ackDate).getTime()
        const hoursSince = (Date.now() - ackTime) / 3_600_000
        if (hoursSince > 24) {
          return `⛔ IRN cancellation window expired.\n\nIRN was generated ${Math.round(hoursSince)} hours ago (ACK date: ${ackDate}). IRP only allows cancellation within 24 hours.\n\n**Required action:** Issue a Credit Note against this invoice instead. The IRN remains valid in IRP records — this is the correct GST compliance procedure.`
        }
        const remaining = Math.round(24 - hoursSince)
        auditStart("cancel_einvoice", args.organization_id, "VOID", "einvoice", args)
        const result = await zohoPost<{ message: string }>(
          `/invoices/${args.invoice_id}/einvoice/cancel`,
          args.organization_id,
          { cancel_reason: args.cancel_reason, cancel_remarks: args.cancel_remarks || "" }
        )
        if (!result.ok) {
          auditFail("cancel_einvoice", args.organization_id, "VOID", "einvoice", result.errorMessage || "unknown")
          return result.errorMessage || "Failed to cancel e-Invoice"
        }
        auditSuccess("cancel_einvoice", args.organization_id, "VOID", "einvoice", einvoiceDetails.irn)
        return `**e-Invoice Cancelled**\n\n- Invoice ID: \`${args.invoice_id}\`\n- IRN: ${einvoiceDetails.irn}\n- Reason: ${args.cancel_reason}\n- Remarks: ${args.cancel_remarks || "N/A"}\n- Time Used: ${Math.round(hoursSince)}h of 24h window (${remaining}h remaining at time of cancellation)`
      }

      return "Could not determine IRN generation time. Verify the invoice has an active IRN before retrying."
    },
  })

  // ─── Generate e-Way Bill ─────────────────────────────────────────────────

  server.addTool({
    name: "generate_eway_bill",
    description: `Generate an e-Way Bill for goods movement under India GST.
Mandatory for movement of goods valued > ₹50,000.
Transporter GSTIN OR vehicle number must be provided.
e-Way Bill validity: 1 day per 200 KM for regular cargo.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1),
      transportation_mode: z.enum(["1", "2", "3", "4"]).describe("1=Road, 2=Rail, 3=Air, 4=Ship"),
      distance: z.number().int().positive().max(4000).describe("Approximate distance in KM (used for validity calculation)"),
      vehicle_type: z.enum(["R", "O"]).optional().describe("R=Regular, O=Over Dimensional Cargo"),
      transporter_id: z.string().optional().describe("Transporter GSTIN (required if no vehicle number)"),
      vehicle_number: z.string().max(20).optional().describe("Vehicle registration number (required if no transporter ID)"),
    }),
    annotations: { title: "Generate e-Way Bill", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      if (!args.transporter_id && !args.vehicle_number) {
        return "Either transporter_id (GSTIN) or vehicle_number is required to generate an e-Way Bill."
      }

      auditStart("generate_eway_bill", args.organization_id, "WRITE", "eway_bill", args)
      const payload: Record<string, unknown> = {
        transportation_mode: args.transportation_mode,
        distance: args.distance,
      }
      if (args.vehicle_type) payload.vehicle_type = args.vehicle_type
      if (args.transporter_id) payload.transporter_id = args.transporter_id
      if (args.vehicle_number) payload.vehicle_number = args.vehicle_number

      const result = await zohoPost<{ ewaybill: any }>(
        `/invoices/${args.invoice_id}/ewaybill`, args.organization_id, payload
      )
      if (!result.ok) {
        auditFail("generate_eway_bill", args.organization_id, "WRITE", "eway_bill", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to generate e-Way Bill"
      }
      const ewb = result.data?.ewaybill
      auditSuccess("generate_eway_bill", args.organization_id, "WRITE", "eway_bill", ewb?.ewb_no)
      const validityDays = Math.ceil(args.distance / 200)
      return `**e-Way Bill Generated**\n\n- Invoice ID: \`${args.invoice_id}\`\n- EWB Number: ${ewb?.ewb_no || "N/A"}\n- Generated: ${ewb?.ewb_date || "N/A"}\n- Valid Until: ${ewb?.ewb_valid_till || "N/A"}\n- Distance: ${args.distance} KM\n- Estimated Validity: ${validityDays} day(s)`
    },
  })

  // ─── GSTR-1 Summary ──────────────────────────────────────────────────────

  server.addTool({
    name: "get_gstr1_summary",
    description: `Fetch GSTR-1 data summary from Zoho Books for review.
Returns B2B invoices, B2C summary, exports, credit notes, and HSN summary.
Review this before filing on the GST portal — compare totals with Zoho data.
return_period format: MMYYYY (e.g. 032026 for March 2026).`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      return_period: gstReturnPeriodSchema,
    }),
    annotations: { title: "GSTR-1 Summary", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>(
        "/gstreturn/gstr1", args.organization_id, { return_period: args.return_period }
      )
      if (!result.ok) return result.errorMessage || "Failed to fetch GSTR-1"
      return `**GSTR-1 Summary** (Period: ${args.return_period})\n\nReview below data before filing on GST portal:\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
    },
  })

  // ─── GSTR-2 Summary ──────────────────────────────────────────────────────

  server.addTool({
    name: "get_gstr2_summary",
    description: `Fetch GSTR-2 (inward supplies / ITC) data from Zoho Books.
Returns purchase invoice data for ITC (Input Tax Credit) reconciliation.
Compare with GSTR-2B auto-populated from GST portal for mismatches.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      return_period: gstReturnPeriodSchema,
    }),
    annotations: { title: "GSTR-2 Summary", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>(
        "/gstreturn/gstr2", args.organization_id, { return_period: args.return_period }
      )
      if (!result.ok) return result.errorMessage || "Failed to fetch GSTR-2"
      return `**GSTR-2 Summary** (Period: ${args.return_period})\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
    },
  })

  // ─── HSN Summary ─────────────────────────────────────────────────────────

  server.addTool({
    name: "get_hsn_summary",
    description: `HSN/SAC-wise sales summary for GSTR-1 Table 12.
Groups transactions by HSN/SAC code with taxable value, CGST, SGST, IGST breakup.
Mandatory for businesses with annual turnover > ₹5Cr — 8-digit HSN required.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      from_date: dateSchema,
      to_date: dateSchema,
    }),
    annotations: { title: "HSN/SAC Summary", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/hsnsummary", args.organization_id, {
        from_date: args.from_date,
        to_date: args.to_date,
      })
      if (!result.ok) return result.errorMessage || "Failed to fetch HSN summary"
      return `**HSN/SAC Summary** (${args.from_date} to ${args.to_date})\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
    },
  })

  // ─── TDS Summary ─────────────────────────────────────────────────────────

  server.addTool({
    name: "get_tds_summary",
    description: `TDS deduction summary by section code and vendor.
Returns TDS deducted, PAN-wise, section-wise for the period.
Use for 26Q/27Q return preparation and reconciliation with Form 26AS.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      from_date: dateSchema,
      to_date: dateSchema,
    }),
    annotations: { title: "TDS Summary", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/tdssummary", args.organization_id, {
        from_date: args.from_date,
        to_date: args.to_date,
      })
      if (!result.ok) return result.errorMessage || "Failed to fetch TDS summary"
      return `**TDS Summary** (${args.from_date} to ${args.to_date})\n\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
    },
  })
}
