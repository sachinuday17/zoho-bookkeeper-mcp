/**
 * Items / Products Tools — Zoho Books India
 * HSN/SAC code format validated before saving.
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"
import { positiveAmountSchema, auditStart, auditSuccess, auditFail } from "../utils/validators.js"

const hsnSacSchema = z
  .string()
  .regex(/^[0-9]{4,8}$|^[0-9]{6}$/, "HSN: 4–8 digits | SAC: 6 digits")
  .optional()

export function registerItemTools(server: FastMCP): void {

  server.addTool({
    name: "list_items",
    description: `List all items/products/services in Zoho Books.
Items are used as line items in invoices and bills.
Returns name, rate, HSN/SAC, tax, and active status.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      filter_by: z.enum(["Status.All", "Status.Active", "Status.Inactive"]).optional(),
      search_text: z.string().max(100).optional().describe("Search by item name"),
      page: z.number().int().positive().optional(),
    }),
    annotations: { title: "List Items", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.filter_by) queryParams.filter_by = args.filter_by
      if (args.search_text) queryParams.search_text = args.search_text
      if (args.page) queryParams.page = args.page.toString()

      const result = await zohoGet<{ items: any[] }>("/items", args.organization_id, queryParams)
      if (!result.ok) return result.errorMessage || "Failed to list items"
      const items = result.data?.items || []
      if (items.length === 0) return "No items found."

      const formatted = items.map((item: any, i: number) =>
        `${i + 1}. **${item.name}** (ID: \`${item.item_id}\`)\n   - Rate: INR ${Number(item.rate).toLocaleString("en-IN")}\n   - HSN/SAC: ${item.hsn_or_sac || "⚠️ Not set"}\n   - Tax: ${item.tax_name || "Not set"}\n   - Type: ${item.item_type || "N/A"}\n   - Status: ${item.status || "active"}`
      ).join("\n\n")

      const noHsn = items.filter((i: any) => !i.hsn_or_sac).length
      const warning = noHsn > 0 ? `\n\n⚠️ ${noHsn} item(s) missing HSN/SAC code — required for GSTR-1 Table 12 compliance.` : ""
      return `**Items** (${items.length})${warning}\n\n${formatted}`
    },
  })

  server.addTool({
    name: "create_item",
    description: `Create a new product or service item in Zoho Books.
Items can be reused across all invoices and bills — avoids repetitive entry.
HSN code (goods) or SAC code (services) is mandatory for GST compliance.
Tax ID links the item to the correct GST rate.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      name: z.string().min(1).max(200),
      rate: positiveAmountSchema,
      description: z.string().max(2000).optional(),
      item_type: z.enum(["sales", "purchases", "both"]).optional().describe("Default: both"),
      hsn_or_sac: hsnSacSchema.describe("MANDATORY for GST: HSN (goods) or SAC (services) code"),
      tax_id: z.string().optional().describe("Default GST tax ID for this item"),
      account_id: z.string().optional().describe("Default income/expense account"),
      unit: z.string().max(25).optional().describe("Unit of measure (e.g. Nos, Kgs, Hrs, Sqft)"),
    }),
    annotations: { title: "Create Item", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      if (!args.hsn_or_sac) {
        return "⚠️ HSN/SAC code is strongly recommended for GST compliance. For services, provide SAC code (6 digits). For goods, provide HSN code (4–8 digits). Proceed with caution if this item is GST-exempt."
      }

      auditStart("create_item", args.organization_id, "WRITE", "item", args)
      const payload: Record<string, unknown> = { name: args.name, rate: args.rate }
      if (args.description) payload.description = args.description
      if (args.item_type) payload.item_type = args.item_type
      if (args.hsn_or_sac) payload.hsn_or_sac = args.hsn_or_sac
      if (args.tax_id) payload.tax_id = args.tax_id
      if (args.account_id) payload.account_id = args.account_id
      if (args.unit) payload.unit = args.unit

      const result = await zohoPost<{ item: any }>("/items", args.organization_id, payload)
      if (!result.ok) {
        auditFail("create_item", args.organization_id, "WRITE", "item", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to create item"
      }
      const item = result.data?.item
      auditSuccess("create_item", args.organization_id, "WRITE", "item", item?.item_id)
      return `**Item Created**\n\n- Item ID: \`${item?.item_id}\`\n- Name: ${item?.name}\n- Rate: INR ${Number(item?.rate).toLocaleString("en-IN")}\n- HSN/SAC: ${item?.hsn_or_sac || "Not set"}\n- Tax: ${item?.tax_name || "Not set"}`
    },
  })

  server.addTool({
    name: "update_item",
    description: `Update an existing item in Zoho Books.
Only provide fields that need changing.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      item_id: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      rate: positiveAmountSchema.optional(),
      description: z.string().max(2000).optional(),
      hsn_or_sac: hsnSacSchema,
      tax_id: z.string().optional(),
      unit: z.string().max(25).optional(),
    }),
    annotations: { title: "Update Item", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("update_item", args.organization_id, "WRITE", "item", args)
      const payload: Record<string, unknown> = {}
      if (args.name) payload.name = args.name
      if (args.rate !== undefined) payload.rate = args.rate
      if (args.description) payload.description = args.description
      if (args.hsn_or_sac) payload.hsn_or_sac = args.hsn_or_sac
      if (args.tax_id) payload.tax_id = args.tax_id
      if (args.unit) payload.unit = args.unit

      const result = await zohoPost<{ item: any }>(`/items/${args.item_id}`, args.organization_id, payload)
      if (!result.ok) {
        auditFail("update_item", args.organization_id, "WRITE", "item", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to update item"
      }
      auditSuccess("update_item", args.organization_id, "WRITE", "item", args.item_id)
      return `**Item Updated**\n\n- Item ID: \`${args.item_id}\`\n- Name: ${result.data?.item?.name}`
    },
  })
}
