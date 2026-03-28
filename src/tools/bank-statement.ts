/**
 * Bank Statement Categorization Tools — Zoho Books India
 * Correct endpoints confirmed via live API testing
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema, entityIdSchema } from "../utils/validation.js"

export function registerBankStatementTools(server: FastMCP): void {

  server.addTool({
    name: "list_bank_statement_transactions",
    description: `List bank statement feed transactions from Zoho Books Banking module.
Returns uncategorized entries visible in Banking UI.
Use this to get transaction IDs for categorize_bank_statement_transaction.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe("Zoho org ID"),
      account_id: entityIdSchema.describe("Bank account ID (e.g. 1145125000001109343)"),
      status: z.enum(["All", "Uncategorized", "Categorized"]).optional().default("Uncategorized"),
      page: z.number().int().positive().optional(),
      per_page: z.number().int().min(1).max(200).optional(),
    }),
    annotations: { title: "List Bank Statement Feed Transactions", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {
        account_id: args.account_id,
        status: (args.status ?? "Uncategorized").toLowerCase(),
      }
      if (args.page) queryParams.page = args.page.toString()
      if (args.per_page) queryParams.per_page = args.per_page.toString()

      const result = await zohoGet<{ banktransactions: any[] }>("/banktransactions", args.organization_id, queryParams)
      if (!result.ok) return result.errorMessage || "Failed to list bank transactions"

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

  server.addTool({
    name: "categorize_bank_statement_transaction",
    description: `Categorize a bank feed transaction in Zoho Books Banking module.
CORRECT endpoint: POST /banking/transactions/{id}/categorize
Does NOT create a duplicate — links existing feed entry to a GL account.
This is what the Categorize button does in Zoho Banking UI.

transaction_type: expense, deposit, transfer_fund, owner_drawings, owner_contribution, other_income, refund`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe("Zoho org ID"),
      statement_transaction_id: z.string().min(1).describe("transaction_id from list_bank_statement_transactions"),
      transaction_type: z.enum(["expense","deposit","transfer_fund","owner_contribution","owner_drawings","other_income","refund"]),
      gl_account_id: z.string().min(1).describe("GL account ID to categorize against (NOT the bank account)"),
      amount: z.number().positive().max(999_999_999).multipleOf(0.01),
      date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "YYYY-MM-DD"),
      description: z.string().max(500).optional(),
      reference_number: z.string().max(100).optional(),
      vendor_id: z.string().optional().describe("Vendor ID for expense entries"),
      customer_id: z.string().optional().describe("Customer ID for deposit entries"),
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

      const result = await zohoPost<{ message: string }>(
        `/banking/transactions/${args.statement_transaction_id}/categorize`,
        args.organization_id,
        payload
      )

      if (!result.ok) {
        const err = result.errorMessage || "Failed to categorize"
        if (err.toLowerCase().includes("already")) return `⚠️ Transaction \`${args.statement_transaction_id}\` already categorized — skipped.`
        if (err.includes("404")) return `❌ Transaction \`${args.statement_transaction_id}\` not found.`
        return `❌ ${err}`
      }

      return `✅ **Transaction Categorized**\n\n- ID: \`${args.statement_transaction_id}\`\n- Type: ${args.transaction_type}\n- GL Account: \`${args.gl_account_id}\`\n- Amount: INR ${args.amount.toLocaleString("en-IN")}\n- Date: ${args.date}`
    },
  })

  server.addTool({
    name: "match_bank_transaction",
    description: `Match a bank feed transaction to an existing bill, invoice, or payment in Zoho Books.
Links the bank entry to an existing accounting record — no duplicate created.
transaction_type: bill, invoice, vendor_payment, customer_payment`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe("Zoho org ID"),
      statement_transaction_id: z.string().min(1).describe("Bank feed transaction ID"),
      zoho_transaction_id: z.string().min(1).describe("ID of existing bill/invoice/payment to match"),
      transaction_type: z.enum(["bill","invoice","vendor_payment","customer_payment"]),
    }),
    annotations: { title: "Match Bank Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoPost<{ message: string }>(
        `/banking/transactions/${args.statement_transaction_id}/match`,
        args.organization_id,
        { transaction_id: args.zoho_transaction_id, transaction_type: args.transaction_type }
      )
      if (!result.ok) return result.errorMessage || "Failed to match transaction"
      return `✅ **Transaction Matched**\n\n- Bank Entry: \`${args.statement_transaction_id}\`\n- Matched to: \`${args.zoho_transaction_id}\` (${args.transaction_type})`
    },
  })

  server.addTool({
    name: "exclude_bank_transaction",
    description: `Exclude a bank feed transaction from reconciliation.
Use for duplicates, inter-account transfers, or non-business entries.
Excluded entries are hidden but NOT deleted — recoverable from Zoho UI.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe("Zoho org ID"),
      statement_transaction_id: z.string().min(1).describe("Bank feed transaction ID to exclude"),
      reason: z.enum(["duplicate","own_account_transfer","non_business","other"]).describe("Exclusion reason for audit trail"),
    }),
    annotations: { title: "Exclude Bank Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoPost<{ message: string }>(
        `/banking/transactions/${args.statement_transaction_id}/exclude`,
        args.organization_id,
        { reason: args.reason }
      )
      if (!result.ok) return result.errorMessage || "Failed to exclude transaction"
      return `✅ **Transaction Excluded**\n\n- ID: \`${args.statement_transaction_id}\`\n- Reason: ${args.reason}\n\nRecoverable from Zoho Books → Banking → Excluded Transactions.`
    },
  })
}
