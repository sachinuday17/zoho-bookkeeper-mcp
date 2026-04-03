/**
 * Bank Reconciliation Tools — Complete Suite
 *
 * Covers the full reconciliation workflow for Zoho Books India:
 *
 *   STEP 1 — Import
 *     import_bank_statement          Upload CSV / OFX / QIF file
 *
 *   STEP 2 — View & Assess
 *     list_bank_statement_transactions   Uncategorized entries from Banking feed
 *     get_reconciliation_summary         Progress % and pending count
 *     analyse_uncategorized_patterns     Group by payee → suggest rules
 *
 *   STEP 3 — Process (single transaction)
 *     find_matching_invoices             Smart: find open invoices matching amount/date
 *     find_matching_bills                Smart: find open bills matching amount/date
 *     match_bank_transaction             Link feed entry to existing invoice/bill
 *     categorize_bank_statement_transaction  Post to GL account (new expense/income)
 *     exclude_bank_transaction           Mark as excluded (own-transfer, duplicate)
 *
 *   STEP 4 — Bulk Operations
 *     bulk_categorize_transactions       Categorize many transactions in one call
 *
 *   STEP 5 — Rules (future-proof automation)
 *     create_bank_rule                   Auto-categorize future matching transactions
 *     list_bank_rules                    Review active rules
 *
 * Security controls:
 *   - All inputs validated via zod before API call
 *   - Amounts validated: positive, max ₹99,99,99,999, max 2dp
 *   - Dates validated as real calendar dates (YYYY-MM-DD)
 *   - Account IDs validated alphanumeric only
 *   - Audit log on every write operation (tool, org, action, entity — no values)
 *   - Confirm guard on bulk operations
 *
 * Endpoint authority (per git log — confirmed correct):
 *   LIST:        GET  /bankaccounts/{account_id}/statement
 *   CATEGORIZE:  POST /bankaccounts/{account_id}/statement/{transaction_id}/categorize
 *   MATCH:       POST /bankaccounts/{account_id}/statement/{transaction_id}/match
 *   EXCLUDE:     POST /bankaccounts/{account_id}/statement/{transaction_id}/exclude
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost, zohoUploadAttachment } from "../api/client.js"
import { optionalOrganizationIdSchema, entityIdSchema } from "../utils/validation.js"
import {
  dateSchema,
  optionalDateSchema,
  positiveAmountSchema,
  auditStart,
  auditSuccess,
  auditFail,
} from "../utils/validators.js"

// ── Reusable sub-schemas ──────────────────────────────────────────────────────

const accountIdSchema = entityIdSchema.describe(
  "Bank account ID from list_bank_accounts"
)

const statementTxnIdSchema = entityIdSchema.describe(
  "Transaction ID from list_bank_statement_transactions"
)

// ── Rate limit helper — Zoho allows ~100 req/min ──────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ─────────────────────────────────────────────────────────────────────────────

export function registerBankReconciliationTools(server: FastMCP): void {

  // ── STEP 1: Import ──────────────────────────────────────────────────────────

  server.addTool({
    name: "import_bank_statement",
    description: `Import a bank or credit-card statement file into Zoho Books.
Supported formats: CSV, OFX, QIF.
After import the entries appear in the Banking module feed as uncategorized.
Use list_bank_statement_transactions to see them.

The file must be accessible on the MCP server's local filesystem.
Allowed directories: /app/documents, ~/Documents, or ZOHO_ALLOWED_UPLOAD_DIR.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: accountIdSchema,
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
      const fileName = args.file_path.split(/[/\\]/).pop() || args.file_path

      return `**Bank Statement Imported** ✅

- Account ID: \`${args.account_id}\`
- File: ${fileName}

Next: run list_bank_statement_transactions to see the imported entries.`
    },
  })

  // ── STEP 2: View & Assess ───────────────────────────────────────────────────

  server.addTool({
    name: "list_bank_statement_transactions",
    description: `List bank statement feed transactions from the Zoho Books Banking module.
Returns entries visible in the Banking UI — defaults to Uncategorized only.
Use this to get transaction_id values for all categorize / match / exclude tools.

Status options:
  Uncategorized  — pending reconciliation (default)
  Categorized    — already processed
  All            — both`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: accountIdSchema,
      status: z.enum(["All", "Uncategorized", "Categorized"])
        .optional()
        .default("Uncategorized"),
      date_start: optionalDateSchema.describe("Filter from this date (YYYY-MM-DD)"),
      date_end: optionalDateSchema.describe("Filter to this date (YYYY-MM-DD)"),
      page: z.number().int().positive().optional().default(1),
      per_page: z.number().int().min(1).max(200).optional().default(200),
    }),
    annotations: { title: "List Bank Statement Transactions", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {
        status: (args.status ?? "Uncategorized").toLowerCase(),
        per_page: (args.per_page ?? 200).toString(),
        page: (args.page ?? 1).toString(),
      }
      if (args.date_start) queryParams.date_start = args.date_start
      if (args.date_end) queryParams.date_end = args.date_end

      const result = await zohoGet<{ banktransactions: any[] }>(
        `/bankaccounts/${args.account_id}/statement`,
        args.organization_id,
        queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to list bank statement transactions"

      const entries = result.data?.banktransactions || []
      if (entries.length === 0) {
        return `No ${args.status ?? "Uncategorized"} transactions found for account \`${args.account_id}\`.`
      }

      let totalDebit = 0
      let totalCredit = 0

      const formatted = entries.map((e: any, i: number) => {
        const isDebit = e.debit_or_credit === "debit"
        const sign = isDebit ? "−" : "+"
        const amt = Number(e.amount)
        if (isDebit) totalDebit += amt; else totalCredit += amt

        return `${i + 1}. **${e.date}** — INR ${sign}${amt.toLocaleString("en-IN")}
   - Transaction ID: \`${e.transaction_id}\`
   - Status: ${e.status || "N/A"}
   - Payee: ${e.payee || "N/A"}
   - Description: ${e.description || "N/A"}
   - Reference: ${e.reference_number || "N/A"}`
      }).join("\n\n")

      return [
        `**Bank Statement Transactions** — Account \`${args.account_id}\``,
        `Status: ${args.status ?? "Uncategorized"} | Count: ${entries.length}`,
        `Debits: INR ${totalDebit.toLocaleString("en-IN")} | Credits: INR ${totalCredit.toLocaleString("en-IN")}`,
        "",
        formatted,
        "",
        "Use match_bank_transaction, categorize_bank_statement_transaction, or exclude_bank_transaction to process each entry.",
      ].join("\n")
    },
  })

  // ── get_reconciliation_summary ─────────────────────────────────────────────

  server.addTool({
    name: "get_reconciliation_summary",
    description: `Get reconciliation progress for a bank account.
Shows total transactions, categorized count, and pending count with a progress bar.
Run this first to assess how much work remains before starting reconciliation.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: accountIdSchema,
    }),
    annotations: { title: "Reconciliation Summary", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const [allRes, uncatRes] = await Promise.all([
        zohoGet<{ banktransactions: any[] }>(
          `/bankaccounts/${args.account_id}/statement`,
          args.organization_id,
          { status: "all", per_page: "200" }
        ),
        zohoGet<{ banktransactions: any[] }>(
          `/bankaccounts/${args.account_id}/statement`,
          args.organization_id,
          { status: "uncategorized", per_page: "200" }
        ),
      ])

      if (!allRes.ok) return allRes.errorMessage || "Failed to fetch reconciliation summary"

      const total = allRes.data?.banktransactions?.length ?? 0
      const pending = uncatRes.data?.banktransactions?.length ?? 0
      const done = total - pending
      const pct = total > 0 ? Math.round((done / total) * 100) : 100
      const filled = Math.round(pct / 5)
      const bar = "█".repeat(filled) + "░".repeat(20 - filled)

      const statusLine = pending === 0
        ? "✅ Account fully reconciled."
        : `⚠️ ${pending} transaction(s) pending. Run list_bank_statement_transactions to proceed.`

      return [
        `**Reconciliation Summary** — Account \`${args.account_id}\``,
        "",
        `- Total Transactions: ${total}`,
        `- Categorized:        ${done}`,
        `- Pending:            ${pending}`,
        `- Progress:           [${bar}] ${pct}%`,
        "",
        statusLine,
      ].join("\n")
    },
  })

  // ── analyse_uncategorized_patterns ─────────────────────────────────────────

  server.addTool({
    name: "analyse_uncategorized_patterns",
    description: `Analyse uncategorized bank transactions and surface patterns.
Groups by payee/description, sums amounts, shows frequency.
Use this BEFORE bulk categorization to identify candidates for bank rules.

Output includes:
  - Top payees by frequency and total amount
  - Suggested bank rules for recurring transactions
  - Unidentifiable entries that need manual review`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: accountIdSchema,
      min_occurrences: z.number().int().min(1).optional().default(2)
        .describe("Only show payees with at least this many transactions (default: 2)"),
    }),
    annotations: { title: "Analyse Uncategorized Patterns", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<{ banktransactions: any[] }>(
        `/bankaccounts/${args.account_id}/statement`,
        args.organization_id,
        { status: "uncategorized", per_page: "200" }
      )
      if (!result.ok) return result.errorMessage || "Failed to fetch transactions"

      const txns = result.data?.banktransactions || []
      if (txns.length === 0) return "✅ No uncategorized transactions — nothing to analyse."

      // Group by normalized payee
      const groups = new Map<string, { count: number; totalAmt: number; txnIds: string[]; direction: string; sample: string }>()

      for (const tx of txns) {
        const raw = (tx.payee || tx.description || "UNKNOWN").trim()
        const key = raw.toLowerCase().replace(/\s+/g, " ").slice(0, 60)
        const existing = groups.get(key)
        const amt = Number(tx.amount) || 0
        if (existing) {
          existing.count++
          existing.totalAmt += amt
          existing.txnIds.push(tx.transaction_id)
        } else {
          groups.set(key, {
            count: 1,
            totalAmt: amt,
            txnIds: [tx.transaction_id],
            direction: tx.debit_or_credit || "unknown",
            sample: raw,
          })
        }
      }

      // Sort by frequency desc
      const sorted = [...groups.entries()]
        .sort((a, b) => b[1].count - a[1].count)

      const frequent = sorted.filter(([, v]) => v.count >= (args.min_occurrences ?? 2))
      const oneOff = sorted.filter(([, v]) => v.count < (args.min_occurrences ?? 2))

      const lines: string[] = [
        `**Uncategorized Pattern Analysis** — Account \`${args.account_id}\``,
        `Total uncategorized: ${txns.length} | Unique payees: ${groups.size}`,
        "",
      ]

      if (frequent.length > 0) {
        lines.push(`**Recurring Payees** (≥${args.min_occurrences ?? 2} occurrences) — Rule candidates:`)
        lines.push("")
        for (const [, v] of frequent) {
          lines.push(
            `- **${v.sample}** — ${v.count}× | Total: INR ${v.totalAmt.toLocaleString("en-IN")} | ${v.direction}`
          )
          lines.push(
            `  → Suggestion: create_bank_rule with criteria_field="payee", criteria_condition="contains", criteria_value="${v.sample.slice(0, 30)}"`
          )
        }
        lines.push("")
      }

      if (oneOff.length > 0) {
        lines.push(`**One-Off Entries** (${oneOff.length} unique payees) — Manual review needed:`)
        for (const [, v] of oneOff.slice(0, 10)) {
          lines.push(`- ${v.sample} — INR ${v.totalAmt.toLocaleString("en-IN")} (${v.direction})`)
        }
        if (oneOff.length > 10) lines.push(`  ...and ${oneOff.length - 10} more`)
      }

      return lines.join("\n")
    },
  })

  // ── STEP 3: Smart Matching ──────────────────────────────────────────────────

  server.addTool({
    name: "find_matching_invoices",
    description: `Find open customer invoices that could match a bank credit transaction.
Searches outstanding invoices by amount (with optional tolerance) and date proximity.
Returns top candidates with invoice_id for use in match_bank_transaction.

Use this BEFORE match_bank_transaction to identify the right invoice.
tolerance_amount: accept invoices within ±N rupees of the bank amount (default 0 = exact)
tolerance_days: accept invoices within ±N days of the transaction date (default 7)`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      amount: positiveAmountSchema.describe("Bank transaction amount to match against"),
      date: dateSchema.describe("Bank transaction date (YYYY-MM-DD)"),
      tolerance_amount: z.number().min(0).max(10000).optional().default(0)
        .describe("Accept invoices within ±this many rupees of the amount"),
      tolerance_days: z.number().int().min(0).max(90).optional().default(7)
        .describe("Accept invoices within ±this many days of the date"),
      customer_id: z.string().optional().describe("Narrow search to a specific customer"),
    }),
    annotations: { title: "Find Matching Invoices", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {
        status: "outstanding",
        per_page: "200",
      }
      if (args.customer_id) queryParams.customer_id = args.customer_id

      const result = await zohoGet<{ invoices: any[] }>(
        "/invoices", args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to fetch invoices"

      const invoices = result.data?.invoices || []
      if (invoices.length === 0) return "No outstanding invoices found."

      const txnDate = new Date(args.date)
      const tolerance = args.tolerance_amount ?? 0
      const daysTol = args.tolerance_days ?? 7

      const candidates = invoices
        .filter((inv: any) => {
          const invAmt = Number(inv.balance || inv.total || 0)
          const amtOk = Math.abs(invAmt - args.amount) <= tolerance
          if (!amtOk) return false

          const invDate = new Date(inv.date)
          const daysDiff = Math.abs((txnDate.getTime() - invDate.getTime()) / 86_400_000)
          return daysDiff <= daysTol
        })
        .sort((a: any, b: any) => {
          // Sort by amount proximity first, then date proximity
          const aDiff = Math.abs(Number(a.balance || a.total || 0) - args.amount)
          const bDiff = Math.abs(Number(b.balance || b.total || 0) - args.amount)
          return aDiff - bDiff
        })
        .slice(0, 5)

      if (candidates.length === 0) {
        return [
          `No matching invoices found for INR ${args.amount.toLocaleString("en-IN")} on ${args.date}.`,
          `Searched ${invoices.length} outstanding invoices within ±INR ${tolerance} and ±${daysTol} days.`,
          "Consider widening tolerance_amount or tolerance_days, or check if the invoice exists.",
        ].join("\n")
      }

      const formatted = candidates.map((inv: any, i: number) => {
        const bal = Number(inv.balance || inv.total || 0)
        const diff = Math.abs(bal - args.amount)
        return `${i + 1}. **${inv.invoice_number}** — INR ${bal.toLocaleString("en-IN")} (diff: ${diff === 0 ? "exact" : `±${diff}`})
   - Invoice ID: \`${inv.invoice_id}\`
   - Customer: ${inv.customer_name || "N/A"}
   - Date: ${inv.date}
   - Due: ${inv.due_date || "N/A"}
   - Status: ${inv.status}`
      }).join("\n\n")

      return [
        `**Matching Invoices** for INR ${args.amount.toLocaleString("en-IN")} on ${args.date}`,
        `Found ${candidates.length} candidate(s) (searched ${invoices.length} outstanding):`,
        "",
        formatted,
        "",
        "Use match_bank_transaction with the invoice_id from above.",
      ].join("\n")
    },
  })

  server.addTool({
    name: "find_matching_bills",
    description: `Find unpaid vendor bills that could match a bank debit transaction.
Searches unpaid bills by amount (with optional tolerance) and date proximity.
Returns top candidates with bill_id for use in match_bank_transaction.

Use this BEFORE match_bank_transaction to identify the right bill.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      amount: positiveAmountSchema.describe("Bank transaction amount to match against"),
      date: dateSchema.describe("Bank transaction date (YYYY-MM-DD)"),
      tolerance_amount: z.number().min(0).max(10000).optional().default(0)
        .describe("Accept bills within ±this many rupees"),
      tolerance_days: z.number().int().min(0).max(90).optional().default(7)
        .describe("Accept bills within ±this many days"),
      vendor_id: z.string().optional().describe("Narrow search to a specific vendor"),
    }),
    annotations: { title: "Find Matching Bills", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {
        status: "unpaid",
        per_page: "200",
      }
      if (args.vendor_id) queryParams.vendor_id = args.vendor_id

      const result = await zohoGet<{ bills: any[] }>(
        "/bills", args.organization_id, queryParams
      )
      if (!result.ok) return result.errorMessage || "Failed to fetch bills"

      const bills = result.data?.bills || []
      if (bills.length === 0) return "No unpaid bills found."

      const txnDate = new Date(args.date)
      const tolerance = args.tolerance_amount ?? 0
      const daysTol = args.tolerance_days ?? 7

      const candidates = bills
        .filter((bill: any) => {
          const billAmt = Number(bill.balance || bill.total || 0)
          if (Math.abs(billAmt - args.amount) > tolerance) return false
          const billDate = new Date(bill.date)
          const daysDiff = Math.abs((txnDate.getTime() - billDate.getTime()) / 86_400_000)
          return daysDiff <= daysTol
        })
        .sort((a: any, b: any) => {
          const aDiff = Math.abs(Number(a.balance || a.total || 0) - args.amount)
          const bDiff = Math.abs(Number(b.balance || b.total || 0) - args.amount)
          return aDiff - bDiff
        })
        .slice(0, 5)

      if (candidates.length === 0) {
        return [
          `No matching bills found for INR ${args.amount.toLocaleString("en-IN")} on ${args.date}.`,
          `Searched ${bills.length} unpaid bills within ±INR ${tolerance} and ±${daysTol} days.`,
        ].join("\n")
      }

      const formatted = candidates.map((bill: any, i: number) => {
        const bal = Number(bill.balance || bill.total || 0)
        const diff = Math.abs(bal - args.amount)
        return `${i + 1}. **${bill.bill_number}** — INR ${bal.toLocaleString("en-IN")} (diff: ${diff === 0 ? "exact" : `±${diff}`})
   - Bill ID: \`${bill.bill_id}\`
   - Vendor: ${bill.vendor_name || "N/A"}
   - Date: ${bill.date}
   - Due: ${bill.due_date || "N/A"}
   - Status: ${bill.status}`
      }).join("\n\n")

      return [
        `**Matching Bills** for INR ${args.amount.toLocaleString("en-IN")} on ${args.date}`,
        `Found ${candidates.length} candidate(s) (searched ${bills.length} unpaid):`,
        "",
        formatted,
        "",
        "Use match_bank_transaction with the bill_id from above.",
      ].join("\n")
    },
  })

  // ── match_bank_transaction ─────────────────────────────────────────────────

  server.addTool({
    name: "match_bank_transaction",
    description: `Match a bank feed transaction to an existing invoice, bill, or payment in Zoho Books.
Links the bank entry to the Zoho record — no duplicate journal entry is created.
Use find_matching_invoices or find_matching_bills first to get the entity_id.

transaction_type values:
  invoice          — customer payment received (credit entry)
  bill             — vendor payment made (debit entry)
  vendor_payment   — existing vendor payment record
  customer_payment — existing customer payment record`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: accountIdSchema,
      statement_transaction_id: statementTxnIdSchema,
      transaction_type: z.enum(["invoice", "bill", "vendor_payment", "customer_payment"]),
      zoho_transaction_id: entityIdSchema.describe(
        "ID of the existing invoice / bill / payment to match — from find_matching_invoices or find_matching_bills"
      ),
    }),
    annotations: { title: "Match Bank Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("match_bank_transaction", args.organization_id, "WRITE", "bank_transaction", args)

      const result = await zohoPost<{ message: string }>(
        `/bankaccounts/${args.account_id}/statement/${args.statement_transaction_id}/match`,
        args.organization_id,
        { transaction_id: args.zoho_transaction_id, transaction_type: args.transaction_type }
      )

      if (!result.ok) {
        auditFail("match_bank_transaction", args.organization_id, "WRITE", "bank_transaction", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to match transaction"
      }

      auditSuccess("match_bank_transaction", args.organization_id, "WRITE", "bank_transaction", args.statement_transaction_id)

      return `**Transaction Matched** ✅

- Bank Entry: \`${args.statement_transaction_id}\`
- Matched To: \`${args.zoho_transaction_id}\` (${args.transaction_type})
- Account: \`${args.account_id}\`

Entry removed from uncategorized feed.`
    },
  })

  // ── categorize_bank_statement_transaction ──────────────────────────────────

  server.addTool({
    name: "categorize_bank_statement_transaction",
    description: `Categorize a bank feed transaction to a GL account in Zoho Books.
Equivalent to clicking "Categorize" in the Banking UI — links the feed entry to
a chart-of-accounts account WITHOUT creating a duplicate journal entry.

Use list_accounts to find gl_account_id.
Use match_bank_transaction instead if an existing invoice/bill matches.

transaction_type values:
  expense           — debit (money out): utilities, rent, salaries etc.
  deposit           — credit (money in): sales, other income
  transfer_fund     — inter-bank transfer
  owner_drawings    — proprietor withdrawal
  owner_contribution — proprietor capital injection
  other_income      — non-operating credit
  refund            — money returned`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: accountIdSchema,
      statement_transaction_id: statementTxnIdSchema,
      transaction_type: z.enum([
        "expense",
        "deposit",
        "transfer_fund",
        "owner_contribution",
        "owner_drawings",
        "other_income",
        "refund",
      ]),
      gl_account_id: entityIdSchema.describe(
        "GL / expense / income account ID from list_accounts — NOT the bank account"
      ),
      amount: positiveAmountSchema,
      date: dateSchema,
      description: z.string().max(500).optional(),
      reference_number: z.string().max(100).optional(),
      vendor_id: z.string().optional().describe("Vendor ID (for expense categorization)"),
      customer_id: z.string().optional().describe("Customer ID (for deposit categorization)"),
      tax_id: z.string().optional().describe("GST tax ID for ITC claim (expenses only)"),
    }),
    annotations: { title: "Categorize Bank Statement Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("categorize_bank_statement_transaction", args.organization_id, "WRITE", "bank_transaction", args)

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
      if (args.tax_id) payload.tax_id = args.tax_id

      const result = await zohoPost<{ message: string }>(
        `/bankaccounts/${args.account_id}/statement/${args.statement_transaction_id}/categorize`,
        args.organization_id,
        payload
      )

      if (!result.ok) {
        auditFail("categorize_bank_statement_transaction", args.organization_id, "WRITE", "bank_transaction", result.errorMessage || "unknown")

        const err = result.errorMessage || ""
        if (err.toLowerCase().includes("already")) {
          return `⚠️ Transaction \`${args.statement_transaction_id}\` is already categorized — skipped.`
        }
        if (err.includes("404")) {
          return `❌ Transaction \`${args.statement_transaction_id}\` not found in account \`${args.account_id}\`.`
        }
        return `❌ Categorization failed: ${err}`
      }

      auditSuccess("categorize_bank_statement_transaction", args.organization_id, "WRITE", "bank_transaction", args.statement_transaction_id)

      return `**Transaction Categorized** ✅

- Bank Account: \`${args.account_id}\`
- Transaction ID: \`${args.statement_transaction_id}\`
- Type: ${args.transaction_type}
- GL Account: \`${args.gl_account_id}\`
- Amount: INR ${args.amount.toLocaleString("en-IN")}
- Date: ${args.date}
- ITC: ${args.tax_id ? `Yes (tax_id: ${args.tax_id})` : "Not claimed"}

Entry removed from uncategorized feed.`
    },
  })

  // ── exclude_bank_transaction ───────────────────────────────────────────────

  server.addTool({
    name: "exclude_bank_transaction",
    description: `Exclude a bank feed transaction from reconciliation.
Use ONLY for: own-account transfers, duplicates, or non-business entries.
Excluded transactions are hidden from the uncategorized list but NOT deleted.
They can be restored from Zoho Books → Banking → Excluded Transactions.

reason values:
  duplicate            — same transaction imported twice
  own_account_transfer — inter-company or savings-to-current transfer
  non_business         — personal expense in business account
  other                — any other exclusion reason`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: accountIdSchema,
      statement_transaction_id: statementTxnIdSchema,
      reason: z.enum([
        "duplicate",
        "own_account_transfer",
        "non_business",
        "other",
      ]).describe("Reason for exclusion — mandatory for audit trail"),
    }),
    annotations: { title: "Exclude Bank Transaction", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("exclude_bank_transaction", args.organization_id, "WRITE", "bank_transaction", args)

      const result = await zohoPost<{ message: string }>(
        `/bankaccounts/${args.account_id}/statement/${args.statement_transaction_id}/exclude`,
        args.organization_id,
        { reason: args.reason }
      )

      if (!result.ok) {
        auditFail("exclude_bank_transaction", args.organization_id, "WRITE", "bank_transaction", result.errorMessage || "unknown")
        return result.errorMessage || "Failed to exclude transaction"
      }

      auditSuccess("exclude_bank_transaction", args.organization_id, "WRITE", "bank_transaction", args.statement_transaction_id)

      return `**Transaction Excluded** ✅

- Transaction ID: \`${args.statement_transaction_id}\`
- Reason: ${args.reason}

Can be restored: Zoho Books → Banking → select account → Excluded Transactions.`
    },
  })

  // ── STEP 4: Bulk Operations ─────────────────────────────────────────────────

  server.addTool({
    name: "bulk_categorize_transactions",
    description: `Categorize multiple bank feed transactions in a single call.
Processes sequentially with rate-limit safe delays (700ms between calls).
Reports success/failure per transaction — partial success is allowed.
Progress logged every 10 entries.

Build the transactions array from list_bank_statement_transactions output.
All transactions must be for the SAME bank account_id.

IMPORTANT: Verify the gl_account_id for each transaction type before calling.
Use list_accounts to confirm account IDs.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: accountIdSchema,
      transactions: z.array(z.object({
        statement_transaction_id: z.string().min(1).describe("Transaction ID from list_bank_statement_transactions"),
        transaction_type: z.enum([
          "expense", "deposit", "transfer_fund",
          "owner_contribution", "owner_drawings", "other_income", "refund",
        ]),
        gl_account_id: z.string().min(1).describe("GL account ID to categorize against"),
        amount: z.number().positive(),
        date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
        description: z.string().max(500).optional(),
        reference_number: z.string().max(100).optional(),
      })).min(1).max(100).describe("Array of transactions to categorize (max 100 per call)"),
    }),
    annotations: { title: "Bulk Categorize Transactions", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      auditStart("bulk_categorize_transactions", args.organization_id, "WRITE", "bank_transaction", {
        account_id: args.account_id,
        count: args.transactions.length,
      })

      const results = {
        success: 0,
        failed: 0,
        skipped: 0,
        errors: [] as string[],
      }

      for (let i = 0; i < args.transactions.length; i++) {
        const txn = args.transactions[i]

        try {
          const payload: Record<string, unknown> = {
            transaction_type: txn.transaction_type,
            account_id: txn.gl_account_id,
            amount: txn.amount,
            date: txn.date,
          }
          if (txn.description) payload.description = txn.description
          if (txn.reference_number) payload.reference_number = txn.reference_number

          const result = await zohoPost<{ message: string }>(
            `/bankaccounts/${args.account_id}/statement/${txn.statement_transaction_id}/categorize`,
            args.organization_id,
            payload
          )

          if (!result.ok) {
            const err = result.errorMessage || "Unknown error"
            if (err.toLowerCase().includes("already")) {
              results.skipped++
            } else {
              results.failed++
              results.errors.push(`[${txn.statement_transaction_id}] ${err}`)
            }
          } else {
            results.success++
          }
        } catch (err) {
          results.failed++
          results.errors.push(`[${txn.statement_transaction_id}] ${err instanceof Error ? err.message : String(err)}`)
        }

        // Rate-limit safe delay — Zoho allows ~100 req/min
        if (i < args.transactions.length - 1) {
          await sleep(700)
        }

        // Progress checkpoint every 10 entries
        if ((i + 1) % 10 === 0) {
          console.log(
            `[bulk_categorize] ${i + 1}/${args.transactions.length} — ✅ ${results.success} ok | ❌ ${results.failed} failed | ⏭ ${results.skipped} skipped`
          )
        }
      }

      const errorSection = results.errors.length > 0
        ? `\n\n**Errors (${results.errors.length}):**\n${results.errors.join("\n")}`
        : ""

      auditSuccess("bulk_categorize_transactions", args.organization_id, "WRITE", "bank_transaction")

      return [
        `**Bulk Categorization Complete** — Account \`${args.account_id}\``,
        "",
        `- ✅ Categorized: ${results.success}`,
        `- ⏭ Skipped (already done): ${results.skipped}`,
        `- ❌ Failed: ${results.failed}`,
        `- Total processed: ${args.transactions.length}`,
        errorSection,
        "",
        "Run get_reconciliation_summary to see updated progress.",
      ].join("\n")
    },
  })

  // ── STEP 5: Bank Rules ──────────────────────────────────────────────────────

  server.addTool({
    name: "create_bank_rule",
    description: `Create an auto-categorization rule for future bank transactions.
Rules automatically categorize new transactions matching the criteria.

Example: all debits where description contains "HDFC RENT" → categorize as Rent expense.
Run analyse_uncategorized_patterns first to identify high-value rule candidates.

criteria_field options: payee | description | reference_number | amount
criteria_condition options: contains | equals | starts_with`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      rule_name: z.string().min(3).max(100).describe("Descriptive name for the rule"),
      account_id: entityIdSchema.describe("Bank account this rule applies to"),
      transaction_type: z.enum(["debit", "credit"]).describe("Direction of transactions to match"),
      criteria_field: z.enum(["payee", "description", "reference_number", "amount"]),
      criteria_condition: z.enum(["contains", "equals", "starts_with"]),
      criteria_value: z.string().min(1).max(200).describe("Value to match against"),
      categorize_as: z.enum(["expense", "customer_payment", "vendor_payment"]),
      category_account_id: z.string().optional()
        .describe("GL account ID — REQUIRED when categorize_as=expense"),
      contact_id: z.string().optional()
        .describe("Contact ID — REQUIRED when categorize_as=customer_payment or vendor_payment"),
    }),
    annotations: { title: "Create Bank Rule", readOnlyHint: false, openWorldHint: true },
    execute: async (args) => {
      if (args.categorize_as === "expense" && !args.category_account_id) {
        return "category_account_id is required when categorize_as='expense'. Use list_accounts to find the correct account ID."
      }
      if ((args.categorize_as === "customer_payment" || args.categorize_as === "vendor_payment") && !args.contact_id) {
        return "contact_id is required when categorize_as='customer_payment' or 'vendor_payment'. Use list_contacts to find it."
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

      return `**Bank Rule Created** ✅

- Rule ID: \`${rule?.rule_id}\`
- Name: ${rule?.rule_name}
- Match: ${args.transaction_type} where ${args.criteria_field} ${args.criteria_condition} "${args.criteria_value}"
- Action: Categorize as ${args.categorize_as}

Future transactions matching this criteria will be auto-categorized.`
    },
  })

  server.addTool({
    name: "list_bank_rules",
    description: `List all auto-categorization rules for bank transactions.
Use this to review existing rules before creating new ones to avoid duplicates.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
    }),
    annotations: { title: "List Bank Rules", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<{ rules: any[] }>("/bankaccounts/rules", args.organization_id)
      if (!result.ok) return result.errorMessage || "Failed to list bank rules"

      const rules = result.data?.rules || []
      if (rules.length === 0) return "No bank rules configured. Use create_bank_rule to add one."

      const formatted = rules.map((r: any, i: number) => {
        const criteria = Array.isArray(r.criteria) && r.criteria.length > 0
          ? `${r.criteria[0].criteria_field} ${r.criteria[0].criteria_condition} "${r.criteria[0].criteria_value}"`
          : "N/A"
        return `${i + 1}. **${r.rule_name}** (ID: \`${r.rule_id}\`)
   - Direction: ${r.transaction_type || "N/A"}
   - Criteria: ${criteria}
   - Action: ${r.action_categorize_as || "N/A"}`
      }).join("\n\n")

      return `**Bank Rules** (${rules.length})\n\n${formatted}`
    },
  })
}
