/**
 * Journal tools for Zoho Books API
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import {
  zohoGet,
  zohoPost,
  zohoPut,
  zohoDelete,
  zohoUploadAttachment,
  zohoDeleteAttachment,
} from "../api/client.js"
import type { Journal, JournalLineItem, Attachment } from "../api/types.js"
import {
  moneySchema,
  entityIdSchema,
  dateSchema,
  optionalDateSchema,
  optionalOrganizationIdSchema,
} from "../utils/validation.js"

// Zod schema for journal line items with security validation
const lineItemSchema = z.object({
  account_id: entityIdSchema.describe("Account ID from chart of accounts"),
  debit_or_credit: z.enum(["debit", "credit"]).describe("Whether this line is a debit or credit"),
  amount: moneySchema.describe("Amount for this line item (max 999,999,999.99, 2 decimal places)"),
  description: z.string().max(500).optional().describe("Description for this line item"),
  customer_id: entityIdSchema.optional().describe("Customer ID if applicable"),
})

/**
 * Register journal tools on the server
 */
export function registerJournalTools(server: FastMCP): void {
  // List Journals
  server.addTool({
    name: "list_journals",
    description: `List all manual journal entries.
Returns journal entries with date, reference number, and total.
Use date filters to narrow down results.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      date_start: optionalDateSchema.describe("Start date (YYYY-MM-DD)"),
      date_end: optionalDateSchema.describe("End date (YYYY-MM-DD)"),
      sort_column: z.enum(["journal_date", "total", "created_time"]).optional(),
      page: z.number().int().positive().optional().describe("Page number"),
      per_page: z.number().int().min(1).max(200).optional().describe("Items per page (max 200)"),
    }),
    annotations: {
      title: "List Journals",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end
      if (args.sort_column) queryParams.sort_column = args.sort_column
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      const result = await zohoGet<{ journals: Journal[] }>(
        "/journals",
        args.organization_id,
        queryParams
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to list journals"
      }

      const journals = result.data?.journals || []

      if (journals.length === 0) {
        return "No journal entries found."
      }

      const formatted = journals
        .map((j, index) => {
          return `${index + 1}. **${j.journal_date}** - ${j.reference_number || j.entry_number || "No ref"}
   - Journal ID: \`${j.journal_id}\`
   - Total: ${j.currency_code || ""} ${j.total}
   - Notes: ${j.notes || "N/A"}`
        })
        .join("\n\n")

      return `**Journal Entries** (${journals.length} entries)\n\n${formatted}`
    },
  })

  // Get Journal
  server.addTool({
    name: "get_journal",
    description: `Get detailed information about a specific journal entry.
Returns full journal details including all line items.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      journal_id: entityIdSchema.describe("Journal ID"),
    }),
    annotations: {
      title: "Get Journal Details",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ journal: Journal }>(
        `/journals/${args.journal_id}`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to get journal"
      }

      const journal = result.data?.journal

      if (!journal) {
        return "Journal not found"
      }

      let details = `**Journal Entry Details**

- **Journal ID**: \`${journal.journal_id}\`
- **Date**: ${journal.journal_date}
- **Entry Number**: ${journal.entry_number || "N/A"}
- **Reference**: ${journal.reference_number || "N/A"}
- **Total**: ${journal.currency_code || ""} ${journal.total}
- **Notes**: ${journal.notes || "N/A"}

**Line Items**:`

      if (journal.line_items && journal.line_items.length > 0) {
        journal.line_items.forEach((item: JournalLineItem, i: number) => {
          const amount =
            item.debit_or_credit === "debit" ? `Debit: ${item.amount}` : `Credit: ${item.amount}`
          details += `\n${i + 1}. ${item.account_name || item.account_id} - ${amount}`
          if (item.description) details += `\n   Description: ${item.description}`
        })
      }

      return details
    },
  })

  // Create Journal
  server.addTool({
    name: "create_journal",
    description: `Create a new manual journal entry.
Line items must balance (total debits = total credits).
Use list_accounts to find valid account_id values.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      journal_date: dateSchema.describe("Journal date (YYYY-MM-DD)"),
      reference_number: z.string().max(100).optional().describe("Reference number for the journal"),
      notes: z.string().max(2000).optional().describe("Notes or memo for the journal"),
      line_items: z
        .array(lineItemSchema)
        .min(2)
        .describe("Array of line items (min 2, must balance)"),
    }),
    annotations: {
      title: "Create Journal",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      // Validate that debits and credits balance
      let totalDebits = 0
      let totalCredits = 0
      args.line_items.forEach((item) => {
        if (item.debit_or_credit === "debit") {
          totalDebits += item.amount
        } else {
          totalCredits += item.amount
        }
      })

      if (Math.abs(totalDebits - totalCredits) > 0.01) {
        return `**Validation Error**: Journal does not balance.
- Total Debits: ${totalDebits.toFixed(2)}
- Total Credits: ${totalCredits.toFixed(2)}
- Difference: ${Math.abs(totalDebits - totalCredits).toFixed(2)}

Debits must equal credits for a valid journal entry.`
      }

      const payload: Record<string, unknown> = {
        journal_date: args.journal_date,
        line_items: args.line_items,
      }

      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.notes) payload.notes = args.notes

      const result = await zohoPost<{ journal: Journal }>(
        "/journals",
        args.organization_id,
        payload
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to create journal"
      }

      const journal = result.data?.journal

      if (!journal) {
        return "Journal created but no details returned"
      }

      return `**Journal Created Successfully**

- **Journal ID**: \`${journal.journal_id}\`
- **Date**: ${journal.journal_date}
- **Entry Number**: ${journal.entry_number || "N/A"}
- **Total**: ${journal.currency_code || ""} ${journal.total}

Use this journal_id to add attachments or update the journal.`
    },
  })

  // Update Journal
  server.addTool({
    name: "update_journal",
    description: `Update an existing journal entry.
Can update date, reference, notes, and line items.
Line items must still balance after update.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      journal_id: entityIdSchema.describe("Journal ID to update"),
      journal_date: optionalDateSchema.describe("New journal date (YYYY-MM-DD)"),
      reference_number: z.string().max(100).optional().describe("New reference number"),
      notes: z.string().max(2000).optional().describe("New notes"),
      line_items: z
        .array(lineItemSchema)
        .min(2)
        .optional()
        .describe("New line items (replaces existing)"),
    }),
    annotations: {
      title: "Update Journal",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const payload: Record<string, unknown> = {}

      if (args.journal_date) payload.journal_date = args.journal_date
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.notes) payload.notes = args.notes

      if (args.line_items) {
        // Validate balance
        let totalDebits = 0
        let totalCredits = 0
        args.line_items.forEach((item) => {
          if (item.debit_or_credit === "debit") {
            totalDebits += item.amount
          } else {
            totalCredits += item.amount
          }
        })

        if (Math.abs(totalDebits - totalCredits) > 0.01) {
          return `**Validation Error**: Line items do not balance.
- Total Debits: ${totalDebits.toFixed(2)}
- Total Credits: ${totalCredits.toFixed(2)}`
        }

        payload.line_items = args.line_items
      }

      const result = await zohoPut<{ journal: Journal }>(
        `/journals/${args.journal_id}`,
        args.organization_id,
        payload
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to update journal"
      }

      return `**Journal Updated Successfully**

Journal ID: \`${args.journal_id}\``
    },
  })

  // Delete Journal
  server.addTool({
    name: "delete_journal",
    description: `Delete a journal entry.
This action cannot be undone. The journal will be permanently removed.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      journal_id: entityIdSchema.describe("Journal ID to delete"),
    }),
    annotations: {
      title: "Delete Journal",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoDelete(`/journals/${args.journal_id}`, args.organization_id)

      if (!result.ok) {
        return result.errorMessage || "Failed to delete journal"
      }

      return `**Journal Deleted Successfully**

Journal ID \`${args.journal_id}\` has been deleted.`
    },
  })

  // Publish Journal
  server.addTool({
    name: "publish_journal",
    description: `Publish (mark as posted) a draft journal entry.
Published journals are finalized and affect account balances.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      journal_id: entityIdSchema.describe("Journal ID to publish"),
    }),
    annotations: {
      title: "Publish Journal",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoPost(
        `/journals/${args.journal_id}/status/publish`,
        args.organization_id,
        {}
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to publish journal"
      }

      return `**Journal Published Successfully**

Journal ID \`${args.journal_id}\` has been marked as published.`
    },
  })

  // Add Journal Attachment
  server.addTool({
    name: "add_journal_attachment",
    description: `Upload a file attachment to a journal entry.
Supported file types: PDF, PNG, JPG, JPEG, GIF, DOC, DOCX, XLS, XLSX.
Use this to attach invoices, receipts, or supporting documents to journal entries.
Files must be in allowed directories and under 10MB.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      journal_id: entityIdSchema.describe("Journal ID to attach file to"),
      file_path: z.string().max(500).describe("Full local file path to the attachment"),
    }),
    annotations: {
      title: "Add Journal Attachment",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoUploadAttachment(
        `/journals/${args.journal_id}/attachment`,
        args.organization_id,
        args.file_path
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to upload attachment"
      }

      return `**Attachment Added Successfully**

- **Journal ID**: \`${args.journal_id}\`
- **File**: ${args.file_path.split("/").pop()}

The attachment is now associated with this journal entry.`
    },
  })

  // Get Journal Attachment
  server.addTool({
    name: "get_journal_attachment",
    description: `Get attachment information for a journal entry.
Returns details about any files attached to the journal.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      journal_id: entityIdSchema.describe("Journal ID"),
    }),
    annotations: {
      title: "Get Journal Attachment",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ attachment: Attachment; documents: Attachment[] }>(
        `/journals/${args.journal_id}/attachment`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to get attachment"
      }

      const attachment = result.data?.attachment
      const documents = result.data?.documents || []

      if (!attachment && documents.length === 0) {
        return `No attachments found for journal \`${args.journal_id}\`.`
      }

      let details = `**Journal Attachments**\n\n- **Journal ID**: \`${args.journal_id}\`\n`

      if (attachment) {
        details += `\n**Attachment**:
- File: ${attachment.file_name}
- Size: ${attachment.file_size_formatted || "Unknown"}`
      }

      if (documents.length > 0) {
        details += `\n\n**Documents** (${documents.length}):`
        documents.forEach((doc, i) => {
          details += `\n${i + 1}. ${doc.file_name} (${doc.file_size_formatted || "Unknown"})`
        })
      }

      return details
    },
  })

  // Delete Journal Attachment
  server.addTool({
    name: "delete_journal_attachment",
    description: `Delete attachment from a journal entry.
Removes the file association from the journal.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      journal_id: entityIdSchema.describe("Journal ID"),
    }),
    annotations: {
      title: "Delete Journal Attachment",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoDeleteAttachment(
        `/journals/${args.journal_id}/attachment`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to delete attachment"
      }

      return `**Attachment Deleted Successfully**

Attachment removed from journal \`${args.journal_id}\`.`
    },
  })
}
