/**
 * Bill tools for Zoho Books API
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost, zohoUploadAttachment, zohoDeleteAttachment } from "../api/client.js"
import type { Bill, BillLineItem, Attachment } from "../api/types.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"

// Zod schema for bill line items
const billLineItemSchema = z.object({
  account_id: z.string().describe("Account ID from chart of accounts"),
  description: z.string().optional().describe("Description for this line item"),
  amount: z.number().positive().describe("Amount for this line item"),
  tax_id: z.string().optional().describe("Tax ID if applicable"),
})

/**
 * Register bill tools on the server
 */
export function registerBillTools(server: FastMCP): void {
  // List Bills
  server.addTool({
    name: "list_bills",
    description: `List all bills (accounts payable).
Supports filtering by date, vendor, and status.
Returns bill details with vendor, amount, and due date.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      date_start: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_end: z.string().optional().describe("End date (YYYY-MM-DD)"),
      vendor_id: z.string().optional().describe("Filter by vendor"),
      status: z
        .enum(["draft", "open", "overdue", "paid", "void", "partially_paid"])
        .optional()
        .describe("Filter by status"),
      sort_column: z.enum(["date", "due_date", "total", "created_time"]).optional(),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    }),
    annotations: {
      title: "List Bills",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end
      if (args.vendor_id) queryParams.vendor_id = args.vendor_id
      if (args.status) queryParams.status = args.status
      if (args.sort_column) queryParams.sort_column = args.sort_column
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      const result = await zohoGet<{ bills: Bill[] }>("/bills", args.organization_id, queryParams)

      if (!result.ok) {
        return result.errorMessage || "Failed to list bills"
      }

      const bills = result.data?.bills || []

      if (bills.length === 0) {
        return "No bills found."
      }

      const formatted = bills
        .map((b, index) => {
          return `${index + 1}. **${b.bill_number || "No number"}** - ${b.vendor_name || "Unknown vendor"}
   - Bill ID: \`${b.bill_id}\`
   - Date: ${b.date}
   - Due: ${b.due_date || "N/A"}
   - Total: ${b.currency_code || ""} ${b.total}
   - Balance: ${b.currency_code || ""} ${b.balance || 0}
   - Status: ${b.status || "N/A"}`
        })
        .join("\n\n")

      return `**Bills** (${bills.length} items)\n\n${formatted}`
    },
  })

  // Get Bill
  server.addTool({
    name: "get_bill",
    description: `Get detailed information about a specific bill.
Returns full bill details including line items and vendor info.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      bill_id: z.string().describe("Bill ID"),
    }),
    annotations: {
      title: "Get Bill Details",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ bill: Bill }>(`/bills/${args.bill_id}`, args.organization_id)

      if (!result.ok) {
        return result.errorMessage || "Failed to get bill"
      }

      const bill = result.data?.bill

      if (!bill) {
        return "Bill not found"
      }

      let details = `**Bill Details**

- **Bill ID**: \`${bill.bill_id}\`
- **Bill Number**: ${bill.bill_number || "N/A"}
- **Vendor**: ${bill.vendor_name || bill.vendor_id}
- **Date**: ${bill.date}
- **Due Date**: ${bill.due_date || "N/A"}
- **Total**: ${bill.currency_code || ""} ${bill.total}
- **Balance**: ${bill.currency_code || ""} ${bill.balance || 0}
- **Status**: ${bill.status || "N/A"}
- **Reference**: ${bill.reference_number || "N/A"}
- **Notes**: ${bill.notes || "N/A"}

**Line Items**:`

      if (bill.line_items && bill.line_items.length > 0) {
        bill.line_items.forEach((item: BillLineItem, i: number) => {
          details += `\n${i + 1}. ${item.account_name || item.account_id} - ${bill.currency_code || ""} ${item.amount}`
          if (item.description) details += `\n   Description: ${item.description}`
        })
      }

      return details
    },
  })

  // Create Bill
  server.addTool({
    name: "create_bill",
    description: `Create a new bill (accounts payable).
Use list_contacts to find vendor_id values.
Use list_accounts to find account_id values for line items.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      vendor_id: z.string().describe("Vendor ID"),
      bill_number: z.string().optional().describe("Bill/Invoice number from vendor"),
      date: z.string().describe("Bill date (YYYY-MM-DD)"),
      due_date: z.string().optional().describe("Payment due date (YYYY-MM-DD)"),
      reference_number: z.string().optional().describe("Reference number"),
      notes: z.string().optional().describe("Notes"),
      line_items: z.array(billLineItemSchema).min(1).describe("Array of line items"),
    }),
    annotations: {
      title: "Create Bill",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const payload: Record<string, unknown> = {
        vendor_id: args.vendor_id,
        date: args.date,
        line_items: args.line_items,
      }

      if (args.bill_number) payload.bill_number = args.bill_number
      if (args.due_date) payload.due_date = args.due_date
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.notes) payload.notes = args.notes

      const result = await zohoPost<{ bill: Bill }>("/bills", args.organization_id, payload)

      if (!result.ok) {
        return result.errorMessage || "Failed to create bill"
      }

      const bill = result.data?.bill

      if (!bill) {
        return "Bill created but no details returned"
      }

      return `**Bill Created Successfully**

- **Bill ID**: \`${bill.bill_id}\`
- **Bill Number**: ${bill.bill_number || "N/A"}
- **Date**: ${bill.date}
- **Total**: ${bill.currency_code || ""} ${bill.total}

Use this bill_id to add attachments.`
    },
  })

  // Add Bill Attachment
  server.addTool({
    name: "add_bill_attachment",
    description: `Upload a file attachment to a bill.
Supported file types: PDF, PNG, JPG, JPEG, GIF, DOC, DOCX, XLS, XLSX.
Use this to attach vendor invoices or supporting documents.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      bill_id: z.string().describe("Bill ID to attach file to"),
      file_path: z.string().describe("Full local file path to the attachment"),
    }),
    annotations: {
      title: "Add Bill Attachment",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoUploadAttachment(
        `/bills/${args.bill_id}/attachment`,
        args.organization_id,
        args.file_path
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to upload attachment"
      }

      return `**Attachment Added Successfully**

- **Bill ID**: \`${args.bill_id}\`
- **File**: ${args.file_path.split("/").pop()}`
    },
  })

  // Get Bill Attachment
  server.addTool({
    name: "get_bill_attachment",
    description: `Get attachment information for a bill.
Returns details about any files attached to the bill.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      bill_id: z.string().describe("Bill ID"),
    }),
    annotations: {
      title: "Get Bill Attachment",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ documents: Attachment[] }>(
        `/bills/${args.bill_id}/attachment`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to get attachment"
      }

      const documents = result.data?.documents || []

      if (documents.length === 0) {
        return `No attachments found for bill \`${args.bill_id}\`.`
      }

      let details = `**Bill Attachments**\n\n- **Bill ID**: \`${args.bill_id}\`\n\n**Documents** (${documents.length}):`
      documents.forEach((doc, i) => {
        details += `\n${i + 1}. ${doc.file_name} (${doc.file_size_formatted || "Unknown"})`
      })

      return details
    },
  })

  // Delete Bill Attachment
  server.addTool({
    name: "delete_bill_attachment",
    description: `Delete attachment from a bill.
Removes the file association from the bill.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      bill_id: z.string().describe("Bill ID"),
    }),
    annotations: {
      title: "Delete Bill Attachment",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoDeleteAttachment(
        `/bills/${args.bill_id}/attachment`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to delete attachment"
      }

      return `**Attachment Deleted Successfully**

Attachment removed from bill \`${args.bill_id}\`.`
    },
  })
}
