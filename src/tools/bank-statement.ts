/**
 * Bank Statement Feed Tools — Zoho Books India
 * Targets the Banking module feed (NOT the accounting ledger)
 *
 * Tool 1: list_bank_statement_transactions
 *   GET /bankaccounts/{account_id}/statement
 *
 * Tool 2: categorize_bank_statement_transaction
 *   POST /bankaccounts/{account_id}/statement/{statement_id}/categorize
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema, entityIdSchema } from "../utils/validation.js"

export function registerBankStatementTools(server: FastMCP): void {

  // ── Tool 1: list_bank_statement_transactions ──────────────────────────────

  server.addTool({
    name: "list_bank_statement_transactions",
    description: `List bank statement feed transactions from Zoho Books Banking module.
Returns the imported bank statement entries (the 403 uncategorized rows visible in Banking UI).
This is DIFFERENT from list_bank_transactions which returns accounting ledger entries.

Use this to get statement_id values needed for categorize_bank_statement_transaction.
Filter by status=Uncategorized to see pending entries only.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: entityIdSchema.describe(
        "Bank account ID (e.g. 1145125000001109343 for Zoho Payroll Bank Account)"
      ),
      status: z
        .enum(["All", "Uncategorized", "Categorized"])
        .optional()
        .default("Uncategorized")
        .describe("Filter by status. Default: Uncategorized"),
      page: z.number().int().positive().optional().describe("Page number (default: 1)"),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Results per page (max 200)"),
    }),
    annotations: {
      title: "List Bank Statement Feed Transactions",
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args) => {
     const queryParams: Record<string, string> = {
  account_id: args.account_id,
  filter_by: `Status.${args.status ?? "Uncategorized"}`,
}
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      const result = await zohoGet<{ statement: any[] }>(
        `/banktransactions`,
        args.organization_id,
        queryParams
      )

      if (!result.ok) {
        const err = result.errorMessage || "Failed to list bank statement transactions"
        if (err.includes("404")) return `Bank account \`${args.account_id}\` not found. Verify the account ID using list_bank_accounts.`
        if (err.includes("401")) return "Authentication failed. Check ZOHO_ACCESS_TOKEN on Railway."
        return err
      }

      const entries = result.data?.statement || []

      if (entries.length === 0) {
        return `No ${args.status ?? "Uncategorized"} bank statement transactions found for account \`${args.account_id}\`.`
      }

      const formatted = entries
        .map((e: any, i: number) => {
          const debit = e.debit_amount ? `Withdrawal: INR ${Number(e.debit_amount).toLocaleString("en-IN")}` : ""
          const credit = e.credit_amount ? `Deposit: INR ${Number(e.credit_amount).toLocaleString("en-IN")}` : ""
          const amt = debit || credit || `Amount: INR ${e.amount || 0}`
          return `${i + 1}. **${e.date}** — ${amt}
   - Statement ID: \`${e.statement_id}\`
   - Status: ${e.status || "uncategorized"}
   - Description: ${e.description || "N/A"}
   - Reference: ${e.reference_number || "N/A"}`
        })
        .join("\n\n")

      return `**Bank Statement Feed** (${entries.length} ${args.status ?? "Uncategorized"} entries)\n\nUse statement_id values with categorize_bank_statement_transaction to categorize each entry.\n\n${formatted}`
    },
  })

  // ── Tool 2: categorize_bank_statement_transaction ─────────────────────────

  server.addTool({
    name: "categorize_bank_statement_transaction",
    description: `Categorize a bank statement feed entry by assigning it to a GL account.
This performs the same action as clicking "Categorize" in Zoho Books Banking UI.

WORKFLOW:
1. Run list_bank_statement_transactions → get statement_id values
2. Run this tool for each entry with the correct gl_account_id and transaction_type

transaction_type guide:
  expense         → outflow to any expense account (most outflows)
  deposit         → inflow to income / liability account
  transfer_fund   → transfer between own bank accounts
  owner_drawings  → drawings / equity outflow (Pradeep/Sharath)
  owner_contribution → equity inflow from founders
  other_income    → non-operating income (interest, GST refund)
  refund          → refund receipt from vendor

IMPORTANT: gl_account_id is the GL/expense account, NOT the bank account.
The bank account is passed via account_id (URL parameter).`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: entityIdSchema.describe(
        "Bank account ID containing the statement entry (e.g. 1145125000001109343)"
      ),
      statement_id: z
        .string()
        .min(1)
        .describe("Statement transaction ID from list_bank_statement_transactions"),
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
        .describe("Type of transaction — determines debit/credit side in the GL"),
      gl_account_id: z
        .string()
        .min(1)
        .describe(
          "GL account ID to categorize to (expense/income/asset account — NOT the bank account)"
        ),
      amount: z
        .number()
        .positive()
        .max(999_999_999)
        .multipleOf(0.01)
        .describe("Transaction amount (2 decimal places max)"),
      date: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Date must be YYYY-MM-DD")
        .describe("Transaction date (YYYY-MM-DD)"),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("Description for the categorized entry"),
      reference_number: z
        .string()
        .max(100)
        .optional()
        .describe("Reference number (e.g. Zoho bank transaction ID)"),
      vendor_id: z
        .string()
        .optional()
        .describe("Vendor contact ID — use when categorizing as expense with known vendor"),
      customer_id: z
        .string()
        .optional()
        .describe("Customer contact ID — use when categorizing as deposit from known customer"),
    }),
    annotations: {
      title: "Categorize Bank Statement Transaction",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      // Build Zoho API payload
      // IMPORTANT: In the payload, account_id = GL account (not the bank account)
      // The bank account is already in the URL path
      const payload: Record<string, unknown> = {
        transaction_type: args.transaction_type,
        account_id: args.gl_account_id,   // GL account → maps to account_id in Zoho payload
        amount: args.amount,
        date: args.date,
      }

      if (args.description) payload.description = args.description
      if (args.reference_number) payload.reference_number = args.reference_number
      if (args.vendor_id) payload.vendor_id = args.vendor_id
      if (args.customer_id) payload.customer_id = args.customer_id

      const result = await zohoPost<{ message: string; categorized_transaction?: any }>(
        `/bankaccounts/${args.account_id}/statement/${args.statement_id}/categorize`,
        args.organization_id,
        payload
      )

      if (!result.ok) {
        const err = result.errorMessage || "Failed to categorize transaction"
        if (err.includes("400") || err.toLowerCase().includes("already")) {
          return `⚠️ Statement entry \`${args.statement_id}\` is already categorized — no action taken.`
        }
        if (err.includes("404")) {
          return `❌ Statement entry \`${args.statement_id}\` not found in account \`${args.account_id}\`. Verify the statement_id from list_bank_statement_transactions.`
        }
        if (err.includes("401")) {
          return "❌ Authentication failed. Check ZOHO_ACCESS_TOKEN on Railway."
        }
        return `❌ Categorization failed: ${err}`
      }

      return `✅ **Transaction Categorized**

- Statement ID: \`${args.statement_id}\`
- Type: ${args.transaction_type}
- GL Account ID: \`${args.gl_account_id}\`
- Amount: INR ${args.amount.toLocaleString("en-IN")}
- Date: ${args.date}
- Reference: ${args.reference_number || "N/A"}

Entry has been removed from uncategorized feed in Zoho Books Banking.`
    },
  })
}
