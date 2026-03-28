/**
 * Bank Statement Categorization Tools — Zoho Books India
 * Endpoint verified: /bankaccounts/{account_id}/statement/{id}/categorize
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
Returns uncategorized entries visible in Banking UI.
Use to get transaction_id values for categorize_bank_statement_transaction.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z.string().min(1).describe(
        "Bank account ID — e.g. 1145125000001109343 for Zoho Payroll Bank Account"
      ),
      status: z.enum(["All", "Uncategorized", "Categorized"])
        .optional().default("Uncategorized"),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    }),
    annotations: { title: "List Bank Statement Feed Transactions", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      // FIX: account_id goes in URL path, not query string
      const queryParams: Record<string, string> = {
        status: (args.status ?? "Uncategorized").toLowerCase(),
      }
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      // FIX: correct endpoint — /bankaccounts/{id}/statement, not /banktransactions
      const result = await zohoGet<{ banktransactions: any[] }>(
        `/bankaccounts/${args.account_id}/statement`, args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to list bank statement transactions"

      const entries = result.data?.banktransactions || []
      if (entries.length === 0) return `No ${args.status ?? "Uncategorized"} transactions found.`

      const formatted = entries.map((e: any, i: number) => {
        const sign = e.debit_or_credit === "debit" ? "−" : "+"
        return `${i + 1}. **${e.date}** — INR ${sign}${Number(e.amount).toLocaleString("en-IN")}
   - Transaction ID: \`${e.transaction_id}\`
   - Status: ${e.status}
   - Payee: ${e.payee || "N/A"}
   - Description: ${e.description || "N/A"}`
      }).join("\n\n")

      return `**Bank Feed Transactions** (${entries.length} entries)\n\n${formatted}`
    },
  })

  // ── Tool 2: categorize_bank_statement_transaction ─────────────────────────

  server.addTool({
    name: "categorize_bank_statement_transaction",
    description: `Categorize a bank feed transaction in Zoho Books Banking module.
Performs the same action as the Categorize button in Banking UI.
Does NOT create a duplicate — links existing feed entry to a GL account.

Endpoint: POST /bankaccounts/{account_id}/statement/{transaction_id}/categorize

REQUIRED PARAMETERS:
- account_id: the BANK account ID (1145125000001109343)
- statement_transaction_id: transaction_id from list_bank_statement_transactions
- gl_account_id: the GL/expense/income account to post to
- transaction_type: expense | deposit | transfer_fund | owner_drawings | owner_contribution | other_income | refund`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z.string().min(1).describe(
        "BANK account ID — 1145125000001109343 for Zoho Payroll Bank Account"
      ),
      statement_transaction_id: z.string().min(1).describe(
        "transaction_id from list_bank_statement_transactions"
      ),
      transaction_type: z.enum([
        "expense",
        "deposit",
        "transfer_fund",
        "owner_contribution",
        "owner_drawings",
        "other_income",
        "refund",
      ]).describe("Transaction type — determines GL debit/credit direction"),
      gl_account_id: z.string().min(1).describe(
        "GL account to categorize against — expense/income/asset account, NOT the bank account"
      ),
      amount: z.number().positive().max(999_999_999).describe("Transaction amount"),
      date: z.string().regex(
        /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
        "Date must be YYYY-MM-DD"
      ),
      description: z.string().max(500).optional(),
      reference_number: z.string().max(100).optional(),
      vendor_id: z.string().optional(),
      customer_id: z.string().optional(),
    }),
    annotations: { title: "Categorize Bank Statement Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
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

      // FIX: correct Zoho Books v3 India endpoint — /statement/ not /transactions/
      const result = await zohoPost<{ message: string }>(
        `/bankaccounts/${args.account_id}/statement/${args.statement_transaction_id}/categorize`,
        args.organization_id,
        payload
      )

      if (!result.ok) {
        const err = result.errorMessage || "Failed to categorize transaction"
        if (err.toLowerCase().includes("already")) {
          return `⚠️ Transaction \`${args.statement_transaction_id}\` already categorized — skipped.`
        }
        if (err.includes("404")) {
          return `❌ Transaction \`${args.statement_transaction_id}\` not found in account \`${args.account_id}\`.`
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

Entry removed from uncategorized feed in Zoho Books Banking.`
    },
  })

  // ── Tool 3: match_bank_transaction ────────────────────────────────────────

  server.addTool({
    name: "match_bank_transaction",
    description: `Match a bank feed transaction to an existing bill, invoice, or payment.
Links the bank entry to an existing accounting record — no duplicate created.
transaction_type: bill | invoice | vendor_payment | customer_payment`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z.string().min(1).describe("Bank account ID"),
      statement_transaction_id: z.string().min(1).describe("Bank feed transaction ID"),
      zoho_transaction_id: z.string().min(1).describe("ID of existing bill/invoice/payment to match"),
      transaction_type: z.enum(["bill", "invoice", "vendor_payment", "customer_payment"]),
    }),
    annotations: { title: "Match Bank Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // FIX: correct endpoint — /statement/ not /transactions/
      const result = await zohoPost<{ message: string }>(
        `/bankaccounts/${args.account_id}/statement/${args.statement_transaction_id}/match`,
        args.organization_id,
        { transaction_id: args.zoho_transaction_id, transaction_type: args.transaction_type }
      )
      if (!result.ok) return result.errorMessage || "Failed to match transaction"
      return `✅ **Transaction Matched**\n\n- Bank Entry: \`${args.statement_transaction_id}\`\n- Matched to: \`${args.zoho_transaction_id}\` (${args.transaction_type})`
    },
  })

  // ── Tool 4: exclude_bank_transaction ─────────────────────────────────────

  server.addTool({
    name: "exclude_bank_transaction",
    description: `Exclude a bank feed transaction from reconciliation.
Use for duplicates, inter-account transfers, or non-business entries.
Excluded entries are hidden but recoverable from Zoho UI.
reason: duplicate | own_account_transfer | non_business | other`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: z.string().min(1).describe("Bank account ID"),
      statement_transaction_id: z.string().min(1).describe("Bank feed transaction ID to exclude"),
      reason: z.enum(["duplicate", "own_account_transfer", "non_business", "other"]),
    }),
    annotations: { title: "Exclude Bank Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      // FIX: correct endpoint — /statement/ not /transactions/
      const result = await zohoPost<{ message: string }>(
        `/bankaccounts/${args.account_id}/statement/${args.statement_transaction_id}/exclude`,
        args.organization_id,
        { reason: args.reason }
      )
      if (!result.ok) return result.errorMessage || "Failed to exclude transaction"
      return `✅ **Transaction Excluded**\n\n- ID: \`${args.statement_transaction_id}\`\n- Reason: ${args.reason}`
    },
  })
}