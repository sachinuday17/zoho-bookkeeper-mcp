/**
 * Contact tools for Zoho Books API
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet } from "../api/client.js"
import type { Contact } from "../api/types.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"

/**
 * Register contact tools on the server
 */
export function registerContactTools(server: FastMCP): void {
  // List Contacts
  server.addTool({
    name: "list_contacts",
    description: `List all contacts (customers and vendors).
Supports filtering by contact type (customer or vendor).
Use this to find contact_id values for bills, invoices, and expenses.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      contact_type: z.enum(["customer", "vendor"]).optional().describe("Filter by contact type"),
      status: z.enum(["active", "inactive", "crm", "all"]).optional().describe("Filter by status"),
      search_text: z.string().optional().describe("Search by name or company"),
      sort_column: z.enum(["contact_name", "company_name", "created_time"]).optional(),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    }),
    annotations: {
      title: "List Contacts",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.contact_type) queryParams.contact_type = args.contact_type
      if (args.status) queryParams.status = args.status
      if (args.search_text) queryParams.search_text = args.search_text
      if (args.sort_column) queryParams.sort_column = args.sort_column
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      const result = await zohoGet<{ contacts: Contact[] }>(
        "/contacts",
        args.organization_id,
        queryParams
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to list contacts"
      }

      const contacts = result.data?.contacts || []

      if (contacts.length === 0) {
        return "No contacts found."
      }

      const formatted = contacts
        .map((c, index) => {
          return `${index + 1}. **${c.contact_name}** (${c.contact_type})
   - Contact ID: \`${c.contact_id}\`
   - Company: ${c.company_name || "N/A"}
   - Email: ${c.email || "N/A"}
   - Phone: ${c.phone || "N/A"}
   - Status: ${c.status}`
        })
        .join("\n\n")

      return `**Contacts** (${contacts.length} items)\n\n${formatted}`
    },
  })

  // Get Contact
  server.addTool({
    name: "get_contact",
    description: `Get detailed information about a specific contact.
Returns full contact details including payment terms and currency settings.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      contact_id: z.string().describe("Contact ID"),
    }),
    annotations: {
      title: "Get Contact Details",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ contact: Contact }>(
        `/contacts/${args.contact_id}`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to get contact"
      }

      const contact = result.data?.contact

      if (!contact) {
        return "Contact not found"
      }

      return `**Contact Details**

- **Contact ID**: \`${contact.contact_id}\`
- **Name**: ${contact.contact_name}
- **Type**: ${contact.contact_type}
- **Company**: ${contact.company_name || "N/A"}
- **Email**: ${contact.email || "N/A"}
- **Phone**: ${contact.phone || "N/A"}
- **Status**: ${contact.status}
- **Payment Terms**: ${contact.payment_terms ? `${contact.payment_terms} days` : "N/A"}
- **Currency**: ${contact.currency_code || "N/A"}`
    },
  })
}
