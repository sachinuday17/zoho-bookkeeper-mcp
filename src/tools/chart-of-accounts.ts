/**
 * Chart of Accounts tools for Zoho Books API
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import type { Account, AccountTransaction } from "../api/types.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"

/**
 * Register chart of accounts tools on the server
 */
export function registerChartOfAccountsTools(server: FastMCP): void {
  // List Accounts
  server.addTool({
    name: "list_accounts",
    description: `List all accounts in the chart of accounts.
Supports filtering by account type (e.g., income, expense, asset, liability, equity).
Use this to find account_id values for journal entries and transactions.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      filter_by: z
        .enum([
          "AccountType.All",
          "AccountType.Active",
          "AccountType.Inactive",
          "AccountType.Asset",
          "AccountType.Liability",
          "AccountType.Equity",
          "AccountType.Income",
          "AccountType.Expense",
        ])
        .optional()
        .describe("Filter accounts by type"),
      sort_column: z
        .enum(["account_name", "account_type", "account_code"])
        .optional()
        .describe("Column to sort by"),
    }),
    annotations: {
      title: "List Chart of Accounts",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const queryParams: Record<string, string> = {}
      if (args.filter_by) queryParams.filter_by = args.filter_by
      if (args.sort_column) queryParams.sort_column = args.sort_column

      const result = await zohoGet<{ chartofaccounts: Account[] }>(
        "/chartofaccounts",
        args.organization_id,
        queryParams
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to list accounts"
      }

      const accounts = result.data?.chartofaccounts || []

      if (accounts.length === 0) {
        return "No accounts found."
      }

      const formatted = accounts
        .map((acc, index) => {
          const balance =
            acc.current_balance !== undefined ? ` | Balance: ${acc.current_balance}` : ""
          return `${index + 1}. **${acc.account_name}** (${acc.account_type_formatted})
   - Account ID: \`${acc.account_id}\`
   - Code: ${acc.account_code || "N/A"}
   - Active: ${acc.is_active ? "Yes" : "No"}${balance}`
        })
        .join("\n\n")

      return `**Chart of Accounts** (${accounts.length} accounts)\n\n${formatted}`
    },
  })

  // Get Account
  server.addTool({
    name: "get_account",
    description: `Get detailed information about a specific account.
Returns account details including balance, currency, and parent account info.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z.string().describe("Account ID"),
    }),
    annotations: {
      title: "Get Account Details",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoGet<{ account: Account }>(
        `/chartofaccounts/${args.account_id}`,
        args.organization_id
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to get account"
      }

      const account = result.data?.account

      if (!account) {
        return "Account not found"
      }

      let details = `**Account Details**

- **Name**: ${account.account_name}
- **Account ID**: \`${account.account_id}\`
- **Code**: ${account.account_code || "N/A"}
- **Type**: ${account.account_type_formatted}
- **Active**: ${account.is_active ? "Yes" : "No"}
- **User Created**: ${account.is_user_created ? "Yes" : "No (system account)"}`

      if (account.current_balance !== undefined) {
        details += `\n- **Current Balance**: ${account.currency_code || ""} ${account.current_balance}`
      }

      if (account.parent_account_name) {
        details += `\n- **Parent Account**: ${account.parent_account_name}`
      }

      if (account.description) {
        details += `\n- **Description**: ${account.description}`
      }

      return details
    },
  })

  // Create Account
  server.addTool({
    name: "create_account",
    description: `Create a new account in the chart of accounts.
Account types: income, expense, cost_of_goods_sold, other_income, other_expense,
asset (bank, other_current_asset, fixed_asset, other_asset, cash, accounts_receivable),
liability (other_current_liability, credit_card, long_term_liability, other_liability, accounts_payable),
equity (equity, retained_earnings).`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_name: z.string().describe("Name for the new account"),
      account_type: z
        .string()
        .describe("Account type (e.g., expense, income, bank, accounts_receivable)"),
      account_code: z.string().optional().describe("Optional account code for reference"),
      description: z.string().optional().describe("Description of the account"),
      currency_id: z.string().optional().describe("Currency ID for the account"),
      parent_account_id: z.string().optional().describe("Parent account ID for sub-accounts"),
    }),
    annotations: {
      title: "Create Account",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const payload: Record<string, unknown> = {
        account_name: args.account_name,
        account_type: args.account_type,
      }

      if (args.account_code) payload.account_code = args.account_code
      if (args.description) payload.description = args.description
      if (args.currency_id) payload.currency_id = args.currency_id
      if (args.parent_account_id) payload.parent_account_id = args.parent_account_id

      const result = await zohoPost<{ account: Account }>(
        "/chartofaccounts",
        args.organization_id,
        payload
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to create account"
      }

      const account = result.data?.account

      if (!account) {
        return "Account created but no details returned"
      }

      return `**Account Created Successfully**

- **Name**: ${account.account_name}
- **Account ID**: \`${account.account_id}\`
- **Code**: ${account.account_code || "N/A"}
- **Type**: ${account.account_type_formatted}`
    },
  })

  // List Account Transactions
  server.addTool({
    name: "list_account_transactions",
    description: `List transactions for a specific account.
Returns all transactions (journals, invoices, bills, etc.) affecting this account.
Useful for account reconciliation and analysis.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z.string().describe("Account ID to get transactions for"),
      date_start: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_end: z.string().optional().describe("End date (YYYY-MM-DD)"),
      sort_column: z.enum(["transaction_date", "amount"]).optional().describe("Column to sort by"),
    }),
    annotations: {
      title: "List Account Transactions",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const queryParams: Record<string, string> = {
        account_id: args.account_id,
      }
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end
      if (args.sort_column) queryParams.sort_column = args.sort_column

      const result = await zohoGet<{ transactions: AccountTransaction[] }>(
        "/chartofaccounts/transactions",
        args.organization_id,
        queryParams
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to list transactions"
      }

      const transactions = result.data?.transactions || []

      if (transactions.length === 0) {
        return "No transactions found for this account."
      }

      const formatted = transactions
        .map((tx, index) => {
          const amount =
            tx.debit_or_credit === "debit"
              ? `Debit: ${tx.debit_amount}`
              : `Credit: ${tx.credit_amount}`
          return `${index + 1}. **${tx.transaction_date}** - ${tx.transaction_type_formatted}
   - ${amount}
   - Description: ${tx.description || "N/A"}
   - Offset Account: ${tx.offset_account_name || "N/A"}`
        })
        .join("\n\n")

      return `**Account Transactions** (${transactions.length} transactions)\n\n${formatted}`
    },
  })
}
