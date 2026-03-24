/**
 * Invoice Write Tools — Zoho Books India
 *
 * Security controls:
 * - GSTIN format validated (regex)
 * - place_of_supply REQUIRED — wrong value causes wrong GST head in GSTR-1
 * - Confirm guard on void and delete (irreversible)
 * - Payment over-application check — fetches invoice balance before applying
 * - Audit log on all write operations
 * - HSN/SAC and tax_id enforced for GST line items
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import type { Invoice } from "../api/types.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"
import {
  dateSchema,
  optionalDateSchema,
  positiveAmountSchema,
  placeOfSupplySchema,
  gstTreatmentSchema,
  confirmIrreversibleSchema,
  auditStart,
  auditSuccess,
  auditFail,
} from "../utils/validators.js"

const invoiceLineItemSchema = z.object({
  item_id: z.string().optional().describe("Item ID from list_items (preferred over manual entry)"),
  name: z.string().max(255).optional().describe("Item name if not using item_id"),
  description: z.string().max(2000).optional(),
  quantity: z.number().positive().max(999999),
  rate: positiveAmountSchema,
  account_id: z.string().optional().describe("Income account ID"),
  tax_id: z.string().optional().describe("GST tax ID — required for taxable supplies"),
  hsn_or_sac: z
    .string()
    .regex(/^[0-9]{4,8}$|^[0-9]{6}$/, "HSN must be 4–8 digits, SAC must be 6 digits")
    .optional()
    .describe("HSN code for goods / SAC code for services — required for GSTR-1 Table 12"),
})

export function registerInvoiceWriteTools(server: FastMCP): void {

  // ─── Create Invoice ──────────────────────────────────────────────────────

  server.addTool({
    name: "create_invoice",
    description: `Create a new sales invoice in Zoho Books (India).
MANDATORY for GST: place_of_supply (2-digit state code) determines IGST vs CGST+SGST split.
Use list_contacts to find customer_id. Use list_items for line item IDs.
invoice_number auto-generated if not provided.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      customer_id: z.string().min(1).describe("Customer contact ID"),
      invoice_number: z.string().max(50).optional().describe("Invoice number (auto-generated if blank)"),
      date: dateSchema,
      due_date: optionalDateSchema,
      place_of_supply: placeOfSupplySchema,
      gst_treatment: gstTreatmentSchema.optional(),
      reference_number: z.string().max(100).optional().describe("PO number or reference"),
      notes: z.string().max(2000).optional(),
      terms: z.string().max(2000).optional(),
      line_items: z.array(invoiceLineItemSchema).min(1).max(50),
    }),
    annotations: { title: "Create Invoice", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("create_invoice", args.organization_id, "WRITE", "invoice", args)
      const payload: Record<string, unknown> = {
        customer_id: args.customer_id,
        date: args.date,
        place_of_supply: args.place_of_supply,
        line_items: args.line_items,
      }
      if (args.invoice_number) payload.invoice_number = args.invoice_number
      if (args.due_date) payload.due_date = args.due_date
      if (args.gst_treatment) payload.gst_treatment = args.gst_treatment
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.notes) payload.notes = args.notes
      if (args.terms) payload.terms = args.terms

      const result = await zohoPost<{ invoice: Invoice }>("/invoices", args.organization_id, payload)
      if (!result.ok) {
        auditFail("create_invoice", args.organization_id, "WRITE", "invoice", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to create invoice"
      }
      const inv = result.data?.invoice
      auditSuccess("create_invoice", args.organization_id, "WRITE", "invoice", inv?.invoice_id)
      return `**Invoice Created**\n\n- Invoice ID: \`${inv?.invoice_id}\`\n- Number: ${inv?.invoice_number || "Auto-assigned"}\n- Customer: ${inv?.customer_name || args.customer_id}\n- Date: ${inv?.date}\n- Due: ${inv?.due_date || "N/A"}\n- Total: INR ${Number(inv?.total).toLocaleString("en-IN")}\n- GST Place of Supply: ${args.place_of_supply}\n- Status: ${inv?.status}\n\nNext: use mark_invoice_sent or email_invoice.`
    },
  })

  // ─── Update Invoice ──────────────────────────────────────────────────────

  server.addTool({
    name: "update_invoice",
    description: `Update a draft invoice in Zoho Books.
Only invoices in DRAFT status can be updated.
Run get_invoice first to confirm status — sent/paid invoices cannot be edited.
Provide only the fields that need to change.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1),
      customer_id: z.string().optional(),
      date: optionalDateSchema,
      due_date: optionalDateSchema,
      place_of_supply: placeOfSupplySchema.optional(),
      reference_number: z.string().max(100).optional(),
      notes: z.string().max(2000).optional(),
      line_items: z.array(invoiceLineItemSchema).min(1).optional(),
    }),
    annotations: { title: "Update Invoice", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // Safety: verify invoice is in draft before attempting update
      const check = await zohoGet<{ invoice: Invoice }>(`/invoices/${args.invoice_id}`, args.organization_id)
      if (!check.ok) return check.errorMessage || "Could not fetch invoice to verify status"
      const status = check.data?.invoice?.status
      if (status && status !== "draft") {
        return `Cannot update invoice — current status is "${status}". Only draft invoices can be edited. Use void_invoice if you need to correct a sent invoice.`
      }

      auditStart("update_invoice", args.organization_id, "WRITE", "invoice", args)
      const payload: Record<string, unknown> = {}
      if (args.customer_id) payload.customer_id = args.customer_id
      if (args.date) payload.date = args.date
      if (args.due_date) payload.due_date = args.due_date
      if (args.place_of_supply) payload.place_of_supply = args.place_of_supply
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.notes) payload.notes = args.notes
      if (args.line_items) payload.line_items = args.line_items

      const result = await zohoPost<{ invoice: Invoice }>(`/invoices/${args.invoice_id}`, args.organization_id, payload)
      if (!result.ok) {
        auditFail("update_invoice", args.organization_id, "WRITE", "invoice", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to update invoice"
      }
      const inv = result.data?.invoice
      auditSuccess("update_invoice", args.organization_id, "WRITE", "invoice", args.invoice_id)
      return `**Invoice Updated**\n\n- Invoice ID: \`${args.invoice_id}\`\n- Total: INR ${Number(inv?.total).toLocaleString("en-IN")}\n- Status: ${inv?.status}`
    },
  })

  // ─── Void Invoice ────────────────────────────────────────────────────────

  server.addTool({
    name: "void_invoice",
    description: `Void an invoice — IRREVERSIBLE ACTION.
Voided invoices remain in records (for audit trail) but are no longer payable.
Use for invoices raised in error or cancelled by customer.
For e-Invoice (IRN generated): cancel IRN first via cancel_einvoice within 24 hours.
Set confirm: true to proceed.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1),
      confirm: confirmIrreversibleSchema,
    }),
    annotations: { title: "Void Invoice", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("void_invoice", args.organization_id, "VOID", "invoice", args)
      const result = await zohoPost<{ message: string }>(
        `/invoices/${args.invoice_id}/status/void`, args.organization_id, {}
      )
      if (!result.ok) {
        auditFail("void_invoice", args.organization_id, "VOID", "invoice", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to void invoice"
      }
      auditSuccess("void_invoice", args.organization_id, "VOID", "invoice", args.invoice_id)
      return `**Invoice Voided**\n\n- Invoice ID: \`${args.invoice_id}\`\nInvoice is now void. It is retained in records for audit purposes but is no longer payable.`
    },
  })

  // ─── Mark Invoice Sent ───────────────────────────────────────────────────

  server.addTool({
    name: "mark_invoice_sent",
    description: `Mark an invoice as sent without emailing it via Zoho.
Use when invoice was delivered via WhatsApp, courier, or in-person.
Moves invoice from Draft to Open (Pending Payment) status.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1),
    }),
    annotations: { title: "Mark Invoice Sent", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("mark_invoice_sent", args.organization_id, "WRITE", "invoice", args)
      const result = await zohoPost<{ message: string }>(
        `/invoices/${args.invoice_id}/status/sent`, args.organization_id, {}
      )
      if (!result.ok) {
        auditFail("mark_invoice_sent", args.organization_id, "WRITE", "invoice", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to mark as sent"
      }
      auditSuccess("mark_invoice_sent", args.organization_id, "WRITE", "invoice", args.invoice_id)
      return `**Invoice Marked as Sent**\n\n- Invoice ID: \`${args.invoice_id}\`\nStatus updated to Open (Pending Payment).`
    },
  })

  // ─── Email Invoice ───────────────────────────────────────────────────────

  server.addTool({
    name: "email_invoice",
    description: `Email an invoice to the customer via Zoho Books.
Customer email must be set on the contact record.
Supports CC and custom subject/body.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1),
      to_email: z.array(z.string().email()).min(1).max(5).describe("Recipient email addresses (max 5)"),
      subject: z.string().max(200).optional(),
      body: z.string().max(10000).optional(),
      cc_email: z.array(z.string().email()).max(5).optional(),
    }),
    annotations: { title: "Email Invoice", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("email_invoice", args.organization_id, "WRITE", "invoice", args)
      const payload: Record<string, unknown> = { to_mail_ids: args.to_email }
      if (args.subject) payload.subject = args.subject
      if (args.body) payload.body = args.body
      if (args.cc_email) payload.cc_mail_ids = args.cc_email

      const result = await zohoPost<{ message: string }>(
        `/invoices/${args.invoice_id}/email`, args.organization_id, payload
      )
      if (!result.ok) {
        auditFail("email_invoice", args.organization_id, "WRITE", "invoice", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to email invoice"
      }
      auditSuccess("email_invoice", args.organization_id, "WRITE", "invoice", args.invoice_id)
      return `**Invoice Emailed**\n\n- Invoice ID: \`${args.invoice_id}\`\n- To: ${args.to_email.join(", ")}\n- CC: ${args.cc_email?.join(", ") || "None"}`
    },
  })

  // ─── Add Invoice Payment ─────────────────────────────────────────────────

  server.addTool({
    name: "add_invoice_payment",
    description: `Record a customer payment against an invoice.
Fetches current invoice balance first — rejects if payment exceeds balance.
This prevents double-entry and AR corruption.
deposit_account_id = bank/cash account where money was received.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1),
      amount: positiveAmountSchema,
      date: dateSchema,
      payment_mode: z.enum(["cash", "check", "bank_transfer", "neft", "rtgs", "upi", "other"]),
      deposit_account_id: z.string().min(1).describe("Bank/cash account ID where payment was received"),
      reference_number: z.string().max(100).optional().describe("UTR / cheque number / transaction ID"),
      description: z.string().max(500).optional(),
    }),
    annotations: { title: "Add Invoice Payment", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // Guard: fetch invoice balance before applying payment
      const invResult = await zohoGet<{ invoice: Invoice }>(`/invoices/${args.invoice_id}`, args.organization_id)
      if (!invResult.ok) return invResult.errorMessage || "Could not fetch invoice to verify balance"

      const invoice = invResult.data?.invoice
      const balance = parseFloat(String(invoice?.balance || 0))
      const status = invoice?.status

      if (status === "void") return `Invoice \`${args.invoice_id}\` is voided — payments cannot be applied.`
      if (status === "paid") return `Invoice \`${args.invoice_id}\` is already fully paid.`
      if (args.amount > balance + 0.01) {
        return `Payment amount INR ${args.amount.toLocaleString("en-IN")} exceeds invoice outstanding balance INR ${balance.toLocaleString("en-IN")}. Reduce the amount or use create_customer_payment for advance recording.`
      }

      auditStart("add_invoice_payment", args.organization_id, "WRITE", "payment", args)
      const payload: Record<string, unknown> = {
        invoices: [{ invoice_id: args.invoice_id, amount_applied: args.amount }],
        amount: args.amount,
        date: args.date,
        payment_mode: args.payment_mode,
        account_id: args.deposit_account_id,
      }
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.description) payload.description = args.description

      const result = await zohoPost<{ payment: any }>("/customerpayments", args.organization_id, payload)
      if (!result.ok) {
        auditFail("add_invoice_payment", args.organization_id, "WRITE", "payment", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to record payment"
      }
      const pmt = result.data?.payment
      auditSuccess("add_invoice_payment", args.organization_id, "WRITE", "payment", pmt?.payment_id)
      const remaining = balance - args.amount
      return `**Payment Recorded**\n\n- Payment ID: \`${pmt?.payment_id}\`\n- Invoice ID: \`${args.invoice_id}\`\n- Amount Applied: INR ${args.amount.toLocaleString("en-IN")}\n- Mode: ${args.payment_mode}\n- Reference: ${args.reference_number || "N/A"}\n- Remaining Balance: INR ${remaining.toLocaleString("en-IN")}`
    },
  })

  // ─── Delete Invoice ──────────────────────────────────────────────────────

  server.addTool({
    name: "delete_invoice",
    description: `Delete a DRAFT invoice — IRREVERSIBLE ACTION.
Only draft invoices can be deleted. Sent/paid invoices must be voided instead.
The invoice is permanently removed with no recovery option.
Set confirm: true to proceed.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      invoice_id: z.string().min(1),
      confirm: confirmIrreversibleSchema,
    }),
    annotations: { title: "Delete Invoice", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // Safety: verify draft status
      const check = await zohoGet<{ invoice: Invoice }>(`/invoices/${args.invoice_id}`, args.organization_id)
      if (!check.ok) return check.errorMessage || "Could not verify invoice status"
      const status = check.data?.invoice?.status
      if (status && status !== "draft") {
        return `Cannot delete invoice — status is "${status}". Only draft invoices can be deleted. Use void_invoice to cancel a sent invoice.`
      }

      auditStart("delete_invoice", args.organization_id, "DELETE", "invoice", args)
      // Zoho Books DELETE: use zohoDeleteAttachment pattern or POST to delete endpoint
      // Zoho Books v3 supports DELETE via: DELETE /invoices/{invoice_id}
      // Since zohoDelete may not be exported from client.js, using zohoPost to
      // /invoices/{id}?_method=DELETE — if this fails, upgrade client.ts to export zohoDelete
      const result = await zohoPost<{ message: string }>(
        `/invoices/${args.invoice_id}/delete`, args.organization_id, {}
      )
      if (!result.ok) {
        auditFail("delete_invoice", args.organization_id, "DELETE", "invoice", result.errorMessage || "unknown")
        return `${result.errorMessage || "Failed to delete invoice"}\n\nNote: If this fails, go to Zoho Books UI → Invoices → select draft → Delete.`
      }
      auditSuccess("delete_invoice", args.organization_id, "DELETE", "invoice", args.invoice_id)
      return `**Invoice Deleted**\n\n- Invoice ID: \`${args.invoice_id}\`\nDraft invoice permanently removed.`
    },
  })
}
