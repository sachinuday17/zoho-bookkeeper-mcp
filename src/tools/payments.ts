/**
 * Payment Tools — Zoho Books India
 *
 * Security controls:
 * - Amount validated positive with 2dp max
 * - Payment mode enum-locked
 * - Date format enforced
 * - Audit log on all writes
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"
import {
  dateSchema,
  optionalDateSchema,
  positiveAmountSchema,
  auditStart,
  auditSuccess,
  auditFail,
} from "../utils/validators.js"

const paymentModeSchema = z.enum([
  "cash", "check", "bank_transfer", "neft", "rtgs", "upi", "other"
])

const invoiceApplicationSchema = z.object({
  invoice_id: z.string().min(1),
  amount_applied: positiveAmountSchema,
})

const billApplicationSchema = z.object({
  bill_id: z.string().min(1),
  amount_applied: positiveAmountSchema,
})

export function registerPaymentTools(server: FastMCP): void {

  // ─── List Customer Payments ──────────────────────────────────────────────

  server.addTool({
    name: "list_customer_payments",
    description: `List all customer payments received.
Filter by customer, date range, or payment mode.
Use for cash receipt reconciliation and AR review.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      customer_id: z.string().optional(),
      date_start: optionalDateSchema,
      date_end: optionalDateSchema,
      payment_mode: paymentModeSchema.optional(),
      page: z.number().int().positive().optional(),
    }),
    annotations: { title: "List Customer Payments", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.customer_id) queryParams.customer_id = args.customer_id
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end
      if (args.payment_mode) queryParams.payment_mode = args.payment_mode
      if (args.page) queryParams.page = args.page.toString()

      const result = await zohoGet<{ customerpayments: any[] }>(
        "/customerpayments", args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to list customer payments"
      const payments = result.data?.customerpayments || []
      if (payments.length === 0) return "No customer payments found."

      const total = payments.reduce((s: number, p: any) => s + parseFloat(p.amount || 0), 0)
      const formatted = payments.map((p: any, i: number) =>
        `${i + 1}. **${p.date}** — INR ${Number(p.amount).toLocaleString("en-IN")}\n   - Payment ID: \`${p.payment_id}\`\n   - Customer: ${p.customer_name || "N/A"}\n   - Mode: ${p.payment_mode || "N/A"}\n   - Reference: ${p.reference_number || "N/A"}\n   - Unused: INR ${Number(p.unused_amount || 0).toLocaleString("en-IN")}`
      ).join("\n\n")

      return `**Customer Payments** (${payments.length} | Total: INR ${total.toLocaleString("en-IN")})\n\n${formatted}`
    },
  })

  // ─── Create Customer Payment ─────────────────────────────────────────────

  server.addTool({
    name: "create_customer_payment",
    description: `Record a customer payment in Zoho Books.
Can be applied to one or more invoices in a single entry.
Total of amount_applied across invoices must not exceed payment amount.
Use for NEFT/RTGS/UPI receipts not linked to bank feed.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      customer_id: z.string().min(1),
      amount: positiveAmountSchema.describe("Total payment amount received"),
      date: dateSchema,
      payment_mode: paymentModeSchema,
      deposit_account_id: z.string().min(1).describe("Bank/cash account ID where money was received"),
      reference_number: z.string().max(100).optional().describe("UTR / cheque number"),
      description: z.string().max(500).optional(),
      invoices: z.array(invoiceApplicationSchema).max(10).optional().describe("Invoices to apply payment to (optional — leave blank for advance)"),
    }),
    annotations: { title: "Create Customer Payment", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // Guard: sum of applied amounts must not exceed total
      if (args.invoices) {
        const applied = args.invoices.reduce((s, i) => s + i.amount_applied, 0)
        if (applied > args.amount + 0.01) {
          return `Total applied (INR ${applied.toLocaleString("en-IN")}) exceeds payment amount (INR ${args.amount.toLocaleString("en-IN")}). Reduce the applied amounts.`
        }
      }

      auditStart("create_customer_payment", args.organization_id, "WRITE", "payment", args)
      const payload: Record<string, unknown> = {
        customer_id: args.customer_id,
        amount: args.amount,
        date: args.date,
        payment_mode: args.payment_mode,
        account_id: args.deposit_account_id,
      }
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.description) payload.description = args.description
      if (args.invoices) payload.invoices = args.invoices

      const result = await zohoPost<{ payment: any }>("/customerpayments", args.organization_id, payload)
      if (!result.ok) {
        auditFail("create_customer_payment", args.organization_id, "WRITE", "payment", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to record payment"
      }
      const pmt = result.data?.payment
      auditSuccess("create_customer_payment", args.organization_id, "WRITE", "payment", pmt?.payment_id)
      const unused = args.amount - (args.invoices?.reduce((s, i) => s + i.amount_applied, 0) || 0)
      return `**Customer Payment Recorded**\n\n- Payment ID: \`${pmt?.payment_id}\`\n- Customer: ${pmt?.customer_name || args.customer_id}\n- Amount: INR ${args.amount.toLocaleString("en-IN")}\n- Mode: ${args.payment_mode}\n- Reference: ${args.reference_number || "N/A"}\n- Date: ${args.date}\n- Applied to ${args.invoices?.length || 0} invoice(s)\n- Unused Credit: INR ${unused.toLocaleString("en-IN")}`
    },
  })

  // ─── List Vendor Payments ────────────────────────────────────────────────

  server.addTool({
    name: "list_vendor_payments",
    description: `List all vendor payments made.
Filter by vendor, date range, or payment mode.
Use for AP reconciliation and payment tracking.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      vendor_id: z.string().optional(),
      date_start: optionalDateSchema,
      date_end: optionalDateSchema,
      page: z.number().int().positive().optional(),
    }),
    annotations: { title: "List Vendor Payments", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.vendor_id) queryParams.vendor_id = args.vendor_id
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end
      if (args.page) queryParams.page = args.page.toString()

      const result = await zohoGet<{ vendorpayments: any[] }>(
        "/vendorpayments", args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to list vendor payments"
      const payments = result.data?.vendorpayments || []
      if (payments.length === 0) return "No vendor payments found."

      const total = payments.reduce((s: number, p: any) => s + parseFloat(p.amount || 0), 0)
      const formatted = payments.map((p: any, i: number) =>
        `${i + 1}. **${p.date}** — INR ${Number(p.amount).toLocaleString("en-IN")}\n   - Payment ID: \`${p.payment_id}\`\n   - Vendor: ${p.vendor_name || "N/A"}\n   - Mode: ${p.payment_mode || "N/A"}\n   - Reference: ${p.reference_number || "N/A"}`
      ).join("\n\n")

      return `**Vendor Payments** (${payments.length} | Total: INR ${total.toLocaleString("en-IN")})\n\n${formatted}`
    },
  })

  // ─── Create Vendor Payment ───────────────────────────────────────────────

  server.addTool({
    name: "create_vendor_payment",
    description: `Record a vendor payment in Zoho Books.
Can be applied to one or more bills simultaneously.
paid_through_account_id is the bank/cash account payment was made from.
TDS deduction can be recorded via tds_tax_id if applicable.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      vendor_id: z.string().min(1),
      amount: positiveAmountSchema,
      date: dateSchema,
      payment_mode: paymentModeSchema,
      paid_through_account_id: z.string().min(1).describe("Bank/cash account payment was made from"),
      reference_number: z.string().max(100).optional().describe("UTR / cheque number"),
      description: z.string().max(500).optional(),
      bills: z.array(billApplicationSchema).max(10).optional().describe("Bills to apply payment to"),
    }),
    annotations: { title: "Create Vendor Payment", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // Guard: sum of applied must not exceed total
      if (args.bills) {
        const applied = args.bills.reduce((s, b) => s + b.amount_applied, 0)
        if (applied > args.amount + 0.01) {
          return `Total applied (INR ${applied.toLocaleString("en-IN")}) exceeds payment amount (INR ${args.amount.toLocaleString("en-IN")}). Reduce the applied amounts.`
        }
      }

      auditStart("create_vendor_payment", args.organization_id, "WRITE", "payment", args)
      const payload: Record<string, unknown> = {
        vendor_id: args.vendor_id,
        amount: args.amount,
        date: args.date,
        payment_mode: args.payment_mode,
        account_id: args.paid_through_account_id,
      }
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.description) payload.description = args.description
      if (args.bills) payload.bills = args.bills

      const result = await zohoPost<{ payment: any }>("/vendorpayments", args.organization_id, payload)
      if (!result.ok) {
        auditFail("create_vendor_payment", args.organization_id, "WRITE", "payment", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to record vendor payment"
      }
      const pmt = result.data?.payment
      auditSuccess("create_vendor_payment", args.organization_id, "WRITE", "payment", pmt?.payment_id)
      return `**Vendor Payment Recorded**\n\n- Payment ID: \`${pmt?.payment_id}\`\n- Vendor: ${pmt?.vendor_name || args.vendor_id}\n- Amount: INR ${args.amount.toLocaleString("en-IN")}\n- Mode: ${args.payment_mode}\n- Reference: ${args.reference_number || "N/A"}\n- Applied to ${args.bills?.length || 0} bill(s)`
    },
  })
}
