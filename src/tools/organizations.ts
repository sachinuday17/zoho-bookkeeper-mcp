/**
 * Organization tools for Zoho Books API
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoListOrganizations, zohoGet } from "../api/client.js"
import type { Organization } from "../api/types.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"

/**
 * Register organization tools on the server
 */
export function registerOrganizationTools(server: FastMCP): void {
  // List Organizations
  server.addTool({
    name: "list_organizations",
    description: `List all Zoho organizations the user has access to.
Use this tool first to get organization_id for all other tools.
Returns organization name, ID, currency, and timezone.`,
    parameters: z.object({}),
    annotations: {
      title: "List Organizations",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async () => {
      const result = await zohoListOrganizations()

      if (!result.ok) {
        return result.errorMessage || "Failed to list organizations"
      }

      const organizations = (result.data?.organizations || []) as Organization[]

      if (organizations.length === 0) {
        return "No organizations found. Make sure your Zoho credentials have access to at least one organization."
      }

      const formatted = organizations
        .map((org, index) => {
          return `${index + 1}. **${org.name}**${org.is_default_org ? " (default)" : ""}
   - Organization ID: \`${org.organization_id}\`
   - Currency: ${org.currency_code} (${org.currency_symbol})
   - Timezone: ${org.time_zone}
   - Fiscal Year Start: Month ${org.fiscal_year_start_month}`
        })
        .join("\n\n")

      return `**Zoho Organizations**\n\n${formatted}\n\n---\nUse the organization_id in subsequent API calls.`
    },
  })

  // Get Organization
  server.addTool({
    name: "get_organization",
    description: `Get detailed information about a specific organization.
Returns full organization details including address, contact info, and settings.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
    }),
    annotations: {
      title: "Get Organization Details",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ organization: Organization }>(
        `/organizations/${args.organization_id}`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to get organization"
      }

      const org = result.data?.organization

      if (!org) {
        return "Organization not found"
      }

      return `**Organization Details**

- **Name**: ${org.name}
- **Organization ID**: \`${org.organization_id}\`
- **Default Org**: ${org.is_default_org ? "Yes" : "No"}
- **Currency**: ${org.currency_code} (${org.currency_symbol})
- **Timezone**: ${org.time_zone}
- **Language**: ${org.language_code}
- **Fiscal Year Start**: Month ${org.fiscal_year_start_month}
- **Created**: ${org.account_created_date}`
    },
  })
}
