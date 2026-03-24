/**
 * Bank Reconciliation Tools — Zoho Books India
 *
 * Security controls:
 * - All inputs validated via zod before API call
 * - Audit log on every write operation
 * - No sensitive data in logs (param keys only)
 * - Amounts validated positive with 2dp ceiling
 * - Date format enforced YYYY-MM-DD
 * - Account IDs validated alphanumeric only
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost, zohoUploadAttachment } from "../api/client.js"
import { optionalOrganizationIdSchema, entityIdSchema } from "../utils/validation.js"
import {
  optionalDateSchema,
  dateSchema,
  positiveAmountSchema,
  auditStart,
  auditSuccess,
  auditFail,
} from "../utils/validators.js"

export function registerBankReconciliationTools(server: FastMCP): void {

  // ─── Import Bank Statement ───────────────────────────────────────────────

  server.addTool({
    name: "import_bank_statement",
    description: `Import a bank/credit card statement file into Zoho Books for reconciliation.
Supported formats: CSV, OFX, QIF.
After import, use list_uncategorized_transactions to see imported entries.
The file must be a local path accessible to the MCP server process.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID to import statement into"),
      file_path: z
        .string()
        .min(1)
        .regex(/\.(csv|ofx|qif)$/i, "File must be .csv, .ofx, or .qif")
        .describe("Full local path to the statement file"),
    }),
    annotations: { title: "Import Bank Statement", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("import_bank_statement", args.organization_id, "WRITE", "bank_statement", args)
      const result = await zohoUploadAttachment(
        `/bankstatements?account_id=${args.account_id}`,
        args.organization_id,
        args.file_path
      )
      if (!result.ok) {
        auditFail("import_bank_statement", args.organization_id, "WRITE", "bank_statement", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to import bank statement"
      }
      auditSuccess("import_bank_statement", args.organization_id, "WRITE", "bank_statement")
      return `**Bank Statement Imported**\n\n- Account ID: \`${args.account_id}\`\n- File: ${args.file_path.split(/[\\/]/).pop()}\n\nRun list_uncategorized_transactions to begin categorizing.`
    },
  })

  // ─── List Uncategorized Transactions ────────────────────────────────────

  server.addTool({
    name: "list_uncategorized_transactions",
    description: `List all uncategorized bank transactions pending reconciliation.
These are imported transactions not yet matched to invoices, bills, or accounts.
Start reconciliation by categorizing each entry.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID"),
      date_start: optionalDateSchema.describe("Start date (YYYY-MM-DD)"),
      date_end: optionalDateSchema.describe("End date (YYYY-MM-DD)"),
      page: z.number().int().positive().optional(),
    }),
    annotations: { title: "List Uncategorized Transactions", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {
        account_id: args.account_id,
        status: "uncategorized",
      }
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end
      if (args.page) queryParams.page = args.page.toString()

      const result = await zohoGet<{ banktransactions: any[] }>(
        "/banktransactions", args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to list uncategorized transactions"

      const txns = result.data?.banktransactions || []
      if (txns.length === 0) return "✅ No uncategorized transactions. Account may be fully reconciled."

      const formatted = txns.map((tx: any, i: number) => {
        const sign = tx.debit_or_credit === "debit" ? "−" : "+"
        return `${i + 1}. **${tx.date}** — INR ${sign}${tx.amount}
   - Transaction ID: \`${tx.transaction_id}\`
   - Payee: ${tx.payee || "N/A"}
   - Reference: ${tx.reference_number || "N/A"}
   - Description: ${tx.description || "N/A"}`
      }).join("\n\n")

      const total = txns.reduce((sum: number, tx: any) => sum + (parseFloat(tx.amount) || 0), 0)
      return `**Uncategorized Transactions** (${txns.length} entries | Total: INR ${total.toLocaleString("en-IN")})\n\n${formatted}\n\nUse categorize_as_customer_payment, categorize_as_vendor_payment, categorize_as_expense, or exclude_bank_transaction to process each entry.`
    },
  })

  // ─── Reconciliation Summary ──────────────────────────────────────────────

  server.addTool({
    name: "get_reconciliation_summary",
    description: `Get reconciliation progress summary for a bank account.
Shows total, categorized, and pending transaction counts with completion percentage.
Run this first to assess reconciliation status before starting work.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID"),
    }),
    annotations: { title: "Reconciliation Summary", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const [allRes, uncatRes] = await Promise.all([
        zohoGet<{ banktransactions: any[] }>("/banktransactions", args.organization_id, { account_id: args.account_id }),
        zohoGet<{ banktransactions: any[] }>("/banktransactions", args.organization_id, { account_id: args.account_id, status: "uncategorized" }),
      ])
      if (!allRes.ok) return allRes.errorMessage || "Failed to fetch summary"

      const total = allRes.data?.banktransactions?.length || 0
      const pending = uncatRes.data?.banktransactions?.length || 0
      const done = total - pending
      const pct = total > 0 ? Math.round((done / total) * 100) : 100
      const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5))

      return `**Reconciliation Summary**\n\n- Account ID: \`${args.account_id}\`\n- Total Transactions: ${total}\n- Categorized: ${done}\n- Pending: ${pending}\n- Progress: [${bar}] ${pct}%\n\n${pending === 0 ? "✅ Account fully reconciled." : `⚠️ ${pending} transactions pending. Run list_uncategorized_transactions to proceed.`}`
    },
  })

  // ─── Categorize as Customer Payment ─────────────────────────────────────

  server.addTool({
    name: "categorize_as_customer_payment",
    description: `Categorize an uncategorized bank credit as a customer payment.
Links the bank entry to an existing invoice or records as advance.
Use list_uncategorized_transactions to find transaction_id values.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      transaction_id: z.string().min(1).describe("Uncategorized transaction ID"),
      contact_id: z.string().min(1).describe("Customer contact ID"),
      amount: positiveAmountSchema,
      date: dateSchema.describe("Payment date (YYYY-MM-DD)"),
      invoice_id: z.string().optional().describe("Invoice ID to apply this payment against (optional — leave blank for advance)"),
      reference_number: z.string().max(100).optional().describe("UTR / cheque / reference number"),
    }),
    annotations: { title: "Categorize as Customer Payment", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("categorize_as_customer_payment", args.organization_id, "WRITE", "bank_transaction", args)
      const payload: Record<string, unknown> = {
        contact_id: args.contact_id,
        amount: args.amount,
        date: args.date,
      }
      if (args.invoice_id) payload.invoice_id = args.invoice_id
      if (args.reference_number) payload.reference_number = args.reference_number

      const result = await zohoPost<{ message: string }>(
        `/banktransactions/uncategorizeds/${args.transaction_id}/categorize/customerpayments`,
        args.organization_id,
        payload
      )
      if (!result.ok) {
        auditFail("categorize_as_customer_payment", args.organization_id, "WRITE", "bank_transaction", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to categorize transaction"
      }
      auditSuccess("categorize_as_customer_payment", args.organization_id, "WRITE", "bank_transaction", args.transaction_id)
      return `**Categorized as Customer Payment**\n\n- Transaction ID: \`${args.transaction_id}\`\n- Amount: INR ${args.amount.toLocaleString("en-IN")}\n- Date: ${args.date}\n- Invoice Applied: ${args.invoice_id || "None (advance recorded)"}`
    },
  })

  // ─── Categorize as Vendor Payment ───────────────────────────────────────

  server.addTool({
    name: "categorize_as_vendor_payment",
    description: `Categorize an uncategorized bank debit as a vendor payment.
Links the bank entry to an existing bill or records as advance to vendor.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      transaction_id: z.string().min(1).describe("Uncategorized transaction ID"),
      contact_id: z.string().min(1).describe("Vendor contact ID"),
      amount: positiveAmountSchema,
      date: dateSchema.describe("Payment date (YYYY-MM-DD)"),
      bill_id: z.string().optional().describe("Bill ID to apply this payment against (optional)"),
      reference_number: z.string().max(100).optional().describe("UTR / cheque / reference number"),
    }),
    annotations: { title: "Categorize as Vendor Payment", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("categorize_as_vendor_payment", args.organization_id, "WRITE", "bank_transaction", args)
      const payload: Record<string, unknown> = {
        contact_id: args.contact_id,
        amount: args.amount,
        date: args.date,
      }
      if (args.bill_id) payload.bill_id = args.bill_id
      if (args.reference_number) payload.reference_number = args.reference_number

      const result = await zohoPost<{ message: string }>(
        `/banktransactions/uncategorizeds/${args.transaction_id}/categorize/vendorpayments`,
        args.organization_id,
        payload
      )
      if (!result.ok) {
        auditFail("categorize_as_vendor_payment", args.organization_id, "WRITE", "bank_transaction", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to categorize transaction"
      }
      auditSuccess("categorize_as_vendor_payment", args.organization_id, "WRITE", "bank_transaction", args.transaction_id)
      return `**Categorized as Vendor Payment**\n\n- Transaction ID: \`${args.transaction_id}\`\n- Amount: INR ${args.amount.toLocaleString("en-IN")}\n- Date: ${args.date}\n- Bill Applied: ${args.bill_id || "None (advance recorded)"}`
    },
  })

  // ─── Categorize as Expense ───────────────────────────────────────────────

  server.addTool({
    name: "categorize_as_expense",
    description: `Categorize an uncategorized bank debit as a direct expense.
Use when the transaction is not linked to a vendor bill.
Requires account_id from chart of accounts — use list_accounts to find it.
For GST expenses, provide tax_id for ITC eligibility.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      transaction_id: z.string().min(1).describe("Uncategorized transaction ID"),
      account_id: z.string().min(1).describe("Expense account ID from chart of accounts"),
      amount: positiveAmountSchema,
      date: dateSchema.describe("Expense date (YYYY-MM-DD)"),
      description: z.string().max(500).optional().describe("Expense description"),
      tax_id: z.string().optional().describe("GST tax ID for ITC claim (if applicable)"),
      vendor_id: z.string().optional().describe("Vendor contact ID (optional, for reporting)"),
    }),
    annotations: { title: "Categorize as Expense", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("categorize_as_expense", args.organization_id, "WRITE", "bank_transaction", args)
      const payload: Record<string, unknown> = {
        account_id: args.account_id,
        amount: args.amount,
        date: args.date,
      }
      if (args.description) payload.description = args.description
      if (args.tax_id) payload.tax_id = args.tax_id
      if (args.vendor_id) payload.vendor_id = args.vendor_id

      const result = await zohoPost<{ message: string }>(
        `/banktransactions/uncategorizeds/${args.transaction_id}/categorize/expenses`,
        args.organization_id,
        payload
      )
      if (!result.ok) {
        auditFail("categorize_as_expense", args.organization_id, "WRITE", "bank_transaction", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to categorize as expense"
      }
      auditSuccess("categorize_as_expense", args.organization_id, "WRITE", "bank_transaction", args.transaction_id)
      return `**Categorized as Expense**\n\n- Transaction ID: \`${args.transaction_id}\`\n- Account ID: \`${args.account_id}\`\n- Amount: INR ${args.amount.toLocaleString("en-IN")}\n- ITC: ${args.tax_id ? "Yes (tax_id applied)" : "Not claimed"}`
    },
  })

  // ─── Exclude Transaction ─────────────────────────────────────────────────

  server.addTool({
    name: "exclude_bank_transaction",
    description: `Exclude a transaction from reconciliation.
Use ONLY for: own-account transfers, duplicates, or non-business entries.
Excluded transactions are hidden from uncategorized list but NOT deleted.
They can be restored from Zoho Books UI if excluded in error.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      transaction_id: z.string().min(1).describe("Uncategorized transaction ID to exclude"),
      reason: z.enum([
        "own_account_transfer",
        "duplicate",
        "non_business",
        "other",
      ]).describe("Reason for exclusion — required for audit trail"),
    }),
    annotations: { title: "Exclude Bank Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("exclude_bank_transaction", args.organization_id, "WRITE", "bank_transaction", args)
      const result = await zohoPost<{ message: string }>(
        `/banktransactions/uncategorized/${args.transaction_id}/exclude`,
        args.organization_id,
        {}
      )
      if (!result.ok) {
        auditFail("exclude_bank_transaction", args.organization_id, "WRITE", "bank_transaction", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to exclude transaction"
      }
      auditSuccess("exclude_bank_transaction", args.organization_id, "WRITE", "bank_transaction", args.transaction_id)
      return `**Transaction Excluded**\n\n- Transaction ID: \`${args.transaction_id}\`\n- Reason: ${args.reason}\n\nNote: Can be restored from Zoho Books → Banking → Excluded Transactions if done in error.`
    },
  })

  // ─── Create Bank Rule ────────────────────────────────────────────────────

  server.addTool({
    name: "create_bank_rule",
    description: `Create an auto-categorization rule for future bank transactions.
Rules automatically categorize transactions matching the criteria.
Example: all debits where description contains "GSTIN" → categorize as GST expense.
Saves significant time during monthly bank reconciliation.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      rule_name: z.string().min(3).max(100).describe("Descriptive rule name"),
      account_id: entityIdSchema.describe("Bank account this rule applies to"),
      transaction_type: z.enum(["debit", "credit"]).describe("Transaction direction"),
      criteria_field: z.enum(["payee", "description", "reference_number", "amount"]),
      criteria_condition: z.enum(["contains", "equals", "starts_with"]),
      criteria_value: z.string().min(1).max(200).describe("Value to match"),
      categorize_as: z.enum(["expense", "customer_payment", "vendor_payment"]),
      category_account_id: z.string().optional().describe("Required when categorize_as=expense"),
      contact_id: z.string().optional().describe("Required when categorize_as=customer_payment or vendor_payment"),
    }),
    annotations: { title: "Create Bank Rule", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      if (args.categorize_as === "expense" && !args.category_account_id) {
        return "category_account_id is required when categorize_as is 'expense'. Use list_accounts to find the correct account ID."
      }
      if ((args.categorize_as === "customer_payment" || args.categorize_as === "vendor_payment") && !args.contact_id) {
        return "contact_id is required when categorize_as is 'customer_payment' or 'vendor_payment'. Use list_contacts to find it."
      }

      auditStart("create_bank_rule", args.organization_id, "WRITE", "bank_rule", args)
      const payload: Record<string, unknown> = {
        rule_name: args.rule_name,
        account_id: args.account_id,
        transaction_type: args.transaction_type,
        criteria: [{
          criteria_field: args.criteria_field,
          criteria_condition: args.criteria_condition,
          criteria_value: args.criteria_value,
        }],
        action_categorize_as: args.categorize_as,
      }
      if (args.category_account_id) payload.action_account_id = args.category_account_id
      if (args.contact_id) payload.action_contact_id = args.contact_id

      const result = await zohoPost<{ rule: { rule_id: string; rule_name: string } }>(
        "/bankaccounts/rules", args.organization_id, payload
      )
      if (!result.ok) {
        auditFail("create_bank_rule", args.organization_id, "WRITE", "bank_rule", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to create bank rule"
      }
      const rule = result.data?.rule
      auditSuccess("create_bank_rule", args.organization_id, "WRITE", "bank_rule", rule?.rule_id)
      return `**Bank Rule Created**\n\n- Rule ID: \`${rule?.rule_id}\`\n- Name: ${rule?.rule_name}\n- Match: ${args.transaction_type} where ${args.criteria_field} ${args.criteria_condition} "${args.criteria_value}"\n- Action: Categorize as ${args.categorize_as}`
    },
  })

  // ─── List Bank Rules ─────────────────────────────────────────────────────

  server.addTool({
    name: "list_bank_rules",
    description: `List all auto-categorization rules for bank transactions.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
    }),
    annotations: { title: "List Bank Rules", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<{ rules: any[] }>("/bankaccounts/rules", args.organization_id)
      if (!result.ok) return result.errorMessage || "Failed to list bank rules"
      const rules = result.data?.rules || []
      if (rules.length === 0) return "No bank rules configured."
      const formatted = rules.map((r: any, i: number) =>
        `${i + 1}. **${r.rule_name}** (ID: \`${r.rule_id}\`)\n   - Direction: ${r.transaction_type || "N/A"}\n   - Action: ${r.action_categorize_as || "N/A"}`
      ).join("\n\n")
      return `**Bank Rules** (${rules.length})\n\n${formatted}`
    },
  })
}
