/**
 * Bank Statement Categorization Tools — Zoho Books India
 * Correct endpoints confirmed via live API testing
 *
 * All parameters use explicit z.string() definitions to ensure
 * they surface correctly in the FastMCP tool schema.
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"

export function registerBankStatementTools(server: FastMCP): void {

  // ── Tool 1: list_bank_statement_transactions ──────────────────────────────

  server.addTool({
    name: "list_bank_statement_transactions",
    description: `List bank statement feed transactions from Zoho Books Banking module.
Returns uncategorized entries visible in Banking UI (the 403 rows).
Use to get transaction_id values for categorize_bank_statement_transaction.

status: Uncategorized (default) | Categorized | All`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z
        .string()
        .min(1)
        .describe("Bank account ID — e.g. 1145125000001109343 for Zoho Payroll Bank Account"),
      status: z
        .enum(["All", "Uncategorized", "Categorized"])
        .optional()
        .default("Uncategorized")
        .describe("Filter by status. Default: Uncategorized"),
      page: z.number().int().positive().optional().describe("Page number"),
      per_page: z.number().int().min(1).max(200).optional().describe("Results per page (max 200)"),
    }),
    annotations: {
      title: "List Bank Statement Feed Transactions",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
      const queryParams: Record<string, string> = {
        account_id: args.account_id,
        status: (args.status ?? "Uncategorized").toLowerCase(),
      }
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      const result = await zohoGet<{ banktransactions: any[] }>(
        "/banktransactions",
        args.organization_id,
        queryParams
      )

      if (!result.ok) return result.errorMessage || "Failed to list bank transactions"

      const entries = result.data?.banktransactions || []
      if (entries.length === 0) {
        return `No ${args.status ?? "Uncategorized"} transactions found for account \`${args.account_id}\`.`
      }

      const formatted = entries.map((e: any, i: number) => {
        const sign = e.debit_or_credit === "debit" ? "−" : "+"
        return `${i + 1}. **${e.date}** — INR ${sign}${Number(e.amount).toLocaleString("en-IN")}
   - Transaction ID: \`${e.transaction_id}\`
   - Status: ${e.status}
   - Payee: ${e.payee || "N/A"}
   - Description: ${e.description || "N/A"}
   - Reference: ${e.reference_number || "N/A"}`
      }).join("\n\n")

      return `**Bank Feed Transactions** (${entries.length} ${args.status ?? "Uncategorized"} entries)\n\nUse transaction_id with categorize_bank_statement_transaction.\n\n${formatted}`
    },
  })

  // ── Tool 2: categorize_bank_statement_transaction ─────────────────────────

  server.addTool({
    name: "categorize_bank_statement_transaction",
    description: `Categorize a bank feed transaction in Zoho Books Banking module.
Performs the same action as the "Categorize" button in Banking UI.
Does NOT create a duplicate entry — correctly links the existing feed entry to a GL account.

REQUIRED: account_id = the BANK account (e.g. 1145125000001109343)
REQUIRED: statement_transaction_id = transaction_id from list_bank_statement_transactions
REQUIRED: gl_account_id = the GL/expense/income account to categorize against

transaction_type:
  expense          → outflow to expense account
  deposit          → inflow to income / liability
  transfer_fund    → inter-bank transfer
  owner_drawings   → founder withdrawals
  owner_contribution → founder capital injection
  other_income     → interest, GST refund, non-operating income
  refund           → vendor refund received`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z
        .string()
        .min(1)
        .describe(
          "BANK account ID containing the transaction — e.g. 1145125000001109343 for Zoho Payroll Bank Account"
        ),
      statement_transaction_id: z
        .string()
        .min(1)
        .describe(
          "The transaction_id value from list_bank_statement_transactions — NOT the bank account ID"
        ),
      transaction_type: z
        .enum([
          "expense",
          "deposit",
          "transfer_fund",
          "owner_contribution",
          "owner_drawings",
          "other_income",
          "refund",
        ])
        .describe("Type of transaction — determines GL debit/credit direction"),
      gl_account_id: z
        .string()
        .min(1)
        .describe(
          "GL account ID to categorize against — this is the expense/income/asset account, NOT the bank account"
        ),
      amount: z
        .number()
        .positive()
        .max(999_999_999)
        .describe("Transaction amount (positive number)"),
      date: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Date must be YYYY-MM-DD")
        .describe("Transaction date in YYYY-MM-DD format"),
      description: z.string().max(500).optional().describe("Description for the entry"),
      reference_number: z.string().max(100).optional().describe("Reference number"),
      vendor_id: z.string().optional().describe("Vendor contact ID — for expense entries"),
      customer_id: z.string().optional().describe("Customer contact ID — for deposit entries"),
    }),
    annotations: {
      title: "Categorize Bank Statement Transaction",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      // Build payload — gl_account_id maps to account_id in Zoho payload
      const payload: Record<string, unknown> = {
        transaction_type: args.transaction_type,
        account_id: args.gl_account_id,
        amount: args.amount,
        date: args.date,
      }
      if (args.description) payload.description = args.description
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.vendor_id) payload.vendor_id = args.vendor_id
      if (args.customer_id) payload.customer_id = args.customer_id

      // Correct URL: /banking/{bank_account_id}/transactions/{transaction_id}/categorize
      const result = await zohoPost<{ message: string }>(
        `/banking/${args.account_id}/transactions/${args.statement_transaction_id}/categorize`,
        args.organization_id,
        payload
      )

      if (!result.ok) {
        const err = result.errorMessage || "Failed to categorize transaction"
        if (err.toLowerCase().includes("already")) {
          return `⚠️ Transaction \`${args.statement_transaction_id}\` is already categorized — skipped.`
        }
        if (err.includes("404")) {
          return `❌ Transaction \`${args.statement_transaction_id}\` not found in account \`${args.account_id}\`. Verify IDs from list_bank_statement_transactions.`
        }
        return `❌ Categorization failed: ${err}`
      }

      return `✅ **Transaction Categorized**

- Bank Account: \`${args.account_id}\`
- Transaction ID: \`${args.statement_transaction_id}\`
- Type: ${args.transaction_type}
- GL Account: \`${args.gl_account_id}\`
- Amount: INR ${args.amount.toLocaleString("en-IN")}
- Date: ${args.date}
- Reference: ${args.reference_number || "N/A"}

Entry removed from uncategorized feed in Zoho Books Banking.`
    },
  })

  // ── Tool 3: match_bank_transaction ────────────────────────────────────────

  server.addTool({
    name: "match_bank_transaction",
    description: `Match a bank feed transaction to an existing bill, invoice, or payment in Zoho Books.
Links the bank entry to an existing accounting record — no duplicate entry created.

transaction_type: bill | invoice | vendor_payment | customer_payment`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z
        .string()
        .min(1)
        .describe("Bank account ID containing the transaction"),
      statement_transaction_id: z
        .string()
        .min(1)
        .describe("Bank feed transaction ID from list_bank_statement_transactions"),
      zoho_transaction_id: z
        .string()
        .min(1)
        .describe("ID of the existing bill, invoice, or payment to match against"),
      transaction_type: z
        .enum(["bill", "invoice", "vendor_payment", "customer_payment"])
        .describe("Type of the Zoho record being matched"),
    }),
    annotations: {
      title: "Match Bank Transaction",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoPost<{ message: string }>(
        `/banking/${args.account_id}/transactions/${args.statement_transaction_id}/match`,
        args.organization_id,
        {
          transaction_id: args.zoho_transaction_id,
          transaction_type: args.transaction_type,
        }
      )

      if (!result.ok) {
        const err = result.errorMessage || "Failed to match transaction"
        if (err.toLowerCase().includes("already")) {
          return `⚠️ Transaction \`${args.statement_transaction_id}\` is already matched — skipped.`
        }
        return `❌ Match failed: ${err}`
      }

      return `✅ **Transaction Matched**

- Bank Entry: \`${args.statement_transaction_id}\`
- Matched to: \`${args.zoho_transaction_id}\` (${args.transaction_type})
- Bank Account: \`${args.account_id}\``
    },
  })

  // ── Tool 4: exclude_bank_transaction ─────────────────────────────────────

  server.addTool({
    name: "exclude_bank_transaction",
    description: `Exclude a bank feed transaction from reconciliation.
Use for duplicates, inter-account transfers already recorded, or non-business entries.
Excluded entries are hidden but NOT deleted — recoverable from Zoho UI.

reason: duplicate | own_account_transfer | non_business | other`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z
        .string()
        .min(1)
        .describe("Bank account ID containing the transaction"),
      statement_transaction_id: z
        .string()
        .min(1)
        .describe("Bank feed transaction ID to exclude"),
      reason: z
        .enum(["duplicate", "own_account_transfer", "non_business", "other"])
        .describe("Reason for exclusion — required for audit trail"),
    }),
    annotations: {
      title: "Exclude Bank Transaction",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      const result = await zohoPost<{ message: string }>(
        `/banking/${args.account_id}/transactions/${args.statement_transaction_id}/exclude`,
        args.organization_id,
        { reason: args.reason }
      )

      if (!result.ok) {
        return result.errorMessage || "Failed to exclude transaction"
      }

      return `✅ **Transaction Excluded**

- Transaction ID: \`${args.statement_transaction_id}\`
- Bank Account: \`${args.account_id}\`
- Reason: ${args.reason}

Recoverable from Zoho Books → Banking → Excluded Transactions.`
    },
  })
}
