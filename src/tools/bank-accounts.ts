/**
 * Bank Account Tools — Zoho Books
 *
 * Lean set: account listing and transaction history only.
 * All statement-feed categorization / reconciliation tools live in bank-reconciliation.ts.
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet } from "../api/client.js"
import type { BankAccount, BankTransaction } from "../api/types.js"
import { entityIdSchema, optionalDateSchema, optionalOrganizationIdSchema } from "../utils/validation.js"

export function registerBankAccountTools(server: FastMCP): void {

  // ── list_bank_accounts ─────────────────────────────────────────────────────

  server.addTool({
    name: "list_bank_accounts",
    description: `List all bank and credit-card accounts in Zoho Books.
Returns account ID, name, type, masked account number, and current balance.
Use account_id values from this tool to pass to reconciliation tools.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses active client if not provided)"
      ),
      filter_by: z
        .enum(["Status.All", "Status.Active", "Status.Inactive"])
        .optional()
        .default("Status.Active"),
      sort_column: z.enum(["account_name", "account_type"]).optional(),
    }),
    annotations: { title: "List Bank Accounts", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.filter_by) queryParams.filter_by = args.filter_by
      if (args.sort_column) queryParams.sort_column = args.sort_column

      const result = await zohoGet<{ bankaccounts: BankAccount[] }>(
        "/bankaccounts", args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to list bank accounts"

      const accounts = result.data?.bankaccounts || []
      if (accounts.length === 0) return "No bank accounts found."

      const formatted = accounts.map((acc, i) => {
        const digits = acc.account_number?.replace(/\D/g, "")
        const masked = digits && digits.length >= 4 ? `****${digits.slice(-4)}` : "N/A"
        const balance = acc.balance !== undefined
          ? ` | Balance: ${acc.currency_code || "INR"} ${Number(acc.balance).toLocaleString("en-IN")}`
          : ""
        return `${i + 1}. **${acc.account_name}** (${acc.account_type})
   - Account ID: \`${acc.account_id}\`
   - Bank: ${acc.bank_name || "N/A"}
   - Account Number: ${masked}
   - Active: ${acc.is_active ? "Yes" : "No"}${balance}`
      }).join("\n\n")

      return `**Bank Accounts** (${accounts.length})\n\n${formatted}`
    },
  })

  // ── get_bank_account ───────────────────────────────────────────────────────

  server.addTool({
    name: "get_bank_account",
    description: `Get full details for a specific bank account.
Returns routing number (masked), balance, currency, and active status.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses active client if not provided)"
      ),
      account_id: entityIdSchema.describe("Bank account ID from list_bank_accounts"),
    }),
    annotations: { title: "Get Bank Account Details", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<{ bankaccount: BankAccount }>(
        `/bankaccounts/${args.account_id}`, args.organization_id
      )
      if (!result.ok) return result.errorMessage || "Failed to get bank account"

      const account = result.data?.bankaccount
      if (!account) return "Bank account not found."

      const accountDigits = account.account_number?.replace(/\D/g, "")
      const maskedAcc = accountDigits && accountDigits.length >= 4
        ? `****${accountDigits.slice(-4)}` : "N/A"
      const routingDigits = account.routing_number?.replace(/\D/g, "")
      const maskedRouting = routingDigits && routingDigits.length >= 4
        ? `****${routingDigits.slice(-4)}` : "N/A"

      return `**Bank Account Details**

- **Account ID**: \`${account.account_id}\`
- **Name**: ${account.account_name}
- **Type**: ${account.account_type}
- **Code**: ${account.account_code || "N/A"}
- **Bank Name**: ${account.bank_name || "N/A"}
- **Account Number**: ${maskedAcc}
- **Routing Number**: ${maskedRouting}
- **Currency**: ${account.currency_code || "N/A"}
- **Balance**: ${account.currency_code || "INR"} ${Number(account.balance || 0).toLocaleString("en-IN")}
- **Active**: ${account.is_active ? "Yes" : "No"}`
    },
  })

  // ── list_bank_transactions ─────────────────────────────────────────────────

  server.addTool({
    name: "list_bank_transactions",
    description: `List posted bank transactions recorded in Zoho Books for a given account.
These are transactions already matched/categorized — use list_bank_statement_transactions
to see uncategorized entries pending reconciliation.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses active client if not provided)"
      ),
      account_id: entityIdSchema.describe("Bank account ID"),
      date_start: optionalDateSchema.describe("Start date (YYYY-MM-DD)"),
      date_end: optionalDateSchema.describe("End date (YYYY-MM-DD)"),
      status: z.enum(["All", "uncategorized", "categorized", "excluded"]).optional(),
      sort_column: z.enum(["date", "amount"]).optional(),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    }),
    annotations: { title: "List Bank Transactions", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = { account_id: args.account_id }
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end
      if (args.status) queryParams.status = args.status
      if (args.sort_column) queryParams.sort_column = args.sort_column
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      const result = await zohoGet<{ banktransactions: BankTransaction[] }>(
        "/banktransactions", args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to list bank transactions"

      const transactions = result.data?.banktransactions || []
      if (transactions.length === 0) return "No bank transactions found."

      const formatted = transactions.map((tx, i) => {
        const sign = tx.debit_or_credit === "debit" ? "−" : "+"
        const amount = `${tx.currency_code || "INR"} ${sign}${Number(tx.amount).toLocaleString("en-IN")}`
        return `${i + 1}. **${tx.date}** — ${amount}
   - Transaction ID: \`${tx.transaction_id}\`
   - Type: ${tx.transaction_type || "N/A"}
   - Status: ${tx.status || "N/A"}
   - Payee: ${tx.payee || "N/A"}
   - Reference: ${tx.reference_number || "N/A"}`
      }).join("\n\n")

      return `**Bank Transactions** (${transactions.length})\n\n${formatted}`
    },
  })
}
