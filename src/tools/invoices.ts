/**
 * Invoice tools for Zoho Books API
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoUploadAttachment, zohoDeleteAttachment } from "../api/client.js"
import type { Invoice, Attachment } from "../api/types.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"

/**
 * Register invoice tools on the server
 */
export function registerInvoiceTools(server: FastMCP): void {
  // List Invoices
  server.addTool({
    name: "list_invoices",
    description: `List all customer invoices (accounts receivable).
Supports filtering by date, customer, and status.
Returns invoice details with customer, amount, and due date.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      date_start: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_end: z.string().optional().describe("End date (YYYY-MM-DD)"),
      customer_id: z.string().optional().describe("Filter by customer"),
      status: z
        .enum(["draft", "sent", "overdue", "paid", "void", "partially_paid"])
        .optional()
        .describe("Filter by status"),
      sort_column: z.enum(["date", "due_date", "total", "created_time"]).optional(),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    }),
    annotations: {
      title: "List Invoices",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end
      if (args.customer_id) queryParams.customer_id = args.customer_id
      if (args.status) queryParams.status = args.status
      if (args.sort_column) queryParams.sort_column = args.sort_column
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      const result = await zohoGet<{ invoices: Invoice[] }>(
        "/invoices",
        args.organization_id,
        queryParams
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to list invoices"
      }

      const invoices = result.data?.invoices || []

      if (invoices.length === 0) {
        return "No invoices found."
      }

      const formatted = invoices
        .map((inv, index) => {
          return `${index + 1}. **${inv.invoice_number}** - ${inv.customer_name || "Unknown customer"}
   - Invoice ID: \`${inv.invoice_id}\`
   - Date: ${inv.date}
   - Due: ${inv.due_date || "N/A"}
   - Total: ${inv.currency_code || ""} ${inv.total}
   - Balance: ${inv.currency_code || ""} ${inv.balance || 0}
   - Status: ${inv.status || "N/A"}`
        })
        .join("\n\n")

      return `**Invoices** (${invoices.length} items)\n\n${formatted}`
    },
  })

  // Get Invoice
  server.addTool({
    name: "get_invoice",
    description: `Get detailed information about a specific invoice.
Returns full invoice details including line items and customer info.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      invoice_id: z.string().describe("Invoice ID"),
    }),
    annotations: {
      title: "Get Invoice Details",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ invoice: Invoice }>(
        `/invoices/${args.invoice_id}`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to get invoice"
      }

      const invoice = result.data?.invoice

      if (!invoice) {
        return "Invoice not found"
      }

      let details = `**Invoice Details**

- **Invoice ID**: \`${invoice.invoice_id}\`
- **Invoice Number**: ${invoice.invoice_number}
- **Customer**: ${invoice.customer_name || invoice.customer_id}
- **Date**: ${invoice.date}
- **Due Date**: ${invoice.due_date || "N/A"}
- **Total**: ${invoice.currency_code || ""} ${invoice.total}
- **Balance**: ${invoice.currency_code || ""} ${invoice.balance || 0}
- **Status**: ${invoice.status || "N/A"}
- **Reference**: ${invoice.reference_number || "N/A"}
- **Notes**: ${invoice.notes || "N/A"}`

      if (invoice.line_items && invoice.line_items.length > 0) {
        details += `\n\n**Line Items**:`
        invoice.line_items.forEach((item, i) => {
          details += `\n${i + 1}. ${item.name || item.description || "Item"} - ${invoice.currency_code || ""} ${item.amount}`
          if (item.quantity && item.rate) {
            details += ` (${item.quantity} x ${item.rate})`
          }
        })
      }

      return details
    },
  })

  // Add Invoice Attachment
  server.addTool({
    name: "add_invoice_attachment",
    description: `Upload a file attachment to an invoice.
Supported file types: PDF, PNG, JPG, JPEG, GIF, DOC, DOCX, XLS, XLSX.
Use this to attach supporting documents to invoices.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      invoice_id: z.string().describe("Invoice ID to attach file to"),
      file_path: z.string().describe("Full local file path to the attachment"),
    }),
    annotations: {
      title: "Add Invoice Attachment",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoUploadAttachment(
        `/invoices/${args.invoice_id}/attachment`,
        args.organization_id,
        args.file_path
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to upload attachment"
      }

      return `**Attachment Added Successfully**

- **Invoice ID**: \`${args.invoice_id}\`
- **File**: ${args.file_path.split("/").pop()}`
    },
  })

  // Get Invoice Attachment
  server.addTool({
    name: "get_invoice_attachment",
    description: `Get attachment information for an invoice.
Returns details about any files attached to the invoice.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      invoice_id: z.string().describe("Invoice ID"),
    }),
    annotations: {
      title: "Get Invoice Attachment",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ documents: Attachment[] }>(
        `/invoices/${args.invoice_id}/attachment`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to get attachment"
      }

      const documents = result.data?.documents || []

      if (documents.length === 0) {
        return `No attachments found for invoice \`${args.invoice_id}\`.`
      }

      let details = `**Invoice Attachments**\n\n- **Invoice ID**: \`${args.invoice_id}\`\n\n**Documents** (${documents.length}):`
      documents.forEach((doc, i) => {
        details += `\n${i + 1}. ${doc.file_name} (${doc.file_size_formatted || "Unknown"})`
      })

      return details
    },
  })

  // Delete Invoice Attachment
  server.addTool({
    name: "delete_invoice_attachment",
    description: `Delete attachment from an invoice.
Removes the file association from the invoice.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      invoice_id: z.string().describe("Invoice ID"),
    }),
    annotations: {
      title: "Delete Invoice Attachment",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoDeleteAttachment(
        `/invoices/${args.invoice_id}/attachment`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to delete attachment"
      }

      return `**Attachment Deleted Successfully**

Attachment removed from invoice \`${args.invoice_id}\`.`
    },
  })
}
