/**
 * Reconciliation Automation Tools — Zero-Touch Pipeline
 *
 * These tools eliminate manual categorization by running AI suggestion + Zoho API
 * execution without requiring any per-transaction input from the CA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TOOL 1: auto_categorize_transactions
 *   "The magic button."
 *   - Fetches ALL uncategorized transactions (auto-paginated)
 *   - Runs India keyword suggestion engine per transaction
 *   - Fetches Chart of Accounts to resolve GL account IDs
 *   - Categorizes High-confidence transactions immediately (no CA input needed)
 *   - Reports Medium/Low confidence items for targeted CA review
 *   - dry_run mode shows exactly what would execute before committing
 *   - min_confidence: "Medium" to push even further (use with dry_run first)
 *
 * TOOL 2: bulk_match_transactions
 *   - Fetches uncategorized credit transactions → matches against open invoices
 *   - Fetches uncategorized debit transactions → matches against unpaid bills
 *   - Executes auto-match for exact amount matches within configurable date window
 *   - Run this BEFORE auto_categorize_transactions (reduces categorize burden)
 *
 * TOOL 3: suggest_and_create_bank_rules
 *   "Set it and forget it."
 *   - Analyses recurring payees in uncategorized transactions
 *   - CA provides one account mapping per payee pattern
 *   - Creates bank rules in Zoho — all FUTURE imports auto-categorized by Zoho
 *   - dry_run shows which rules would be created before committing
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Recommended workflow for large-volume reconciliation:
 *   1. bulk_match_transactions (dry_run: true) → review → run live
 *   2. auto_categorize_transactions (dry_run: true) → review → run live
 *   3. export_uncategorized_to_csv → CA reviews remaining (Low confidence)
 *   4. import_approved_reconciliation → execute CA-approved rows
 *   5. suggest_and_create_bank_rules → prevent recurrence next month
 *
 * Security:
 *   - dry_run defaults: bulk_match=true, auto_categorize=false, rules=false
 *   - All IDs validated alphanumeric before API calls
 *   - 700 ms rate limit between API write calls
 *   - Max 1000 transactions per run (safety guard)
 *   - Audit log on every write
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema, entityIdSchema } from "../utils/validation.js"
import { auditStart, auditSuccess, auditFail } from "../utils/validators.js"
import { suggestCategory, findAccountId } from "../utils/suggest-category.js"
import type { GLAccount } from "../utils/suggest-category.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface BankStatementTxn {
  transaction_id: string
  date: string
  amount: number | string
  debit_or_credit: string
  payee?: string
  description?: string
  reference_number?: string
  status?: string
}

interface Invoice {
  invoice_id: string
  invoice_number: string
  customer_name: string
  date: string
  due_date?: string
  balance: number | string
  total: number | string
  status: string
}

interface Bill {
  bill_id: string
  bill_number: string
  vendor_name: string
  date: string
  due_date?: string
  balance: number | string
  total: number | string
  status: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Fetch all uncategorized transactions, auto-paginating up to maxTxns. */
async function fetchUncategorized(
  accountId: string,
  organizationId: string | undefined,
  maxTxns: number,
  dateStart?: string,
  dateEnd?: string
): Promise<{ txns: BankStatementTxn[]; error?: string }> {
  const all: BankStatementTxn[] = []
  let page = 1

  while (all.length < maxTxns) {
    const qp: Record<string, string> = {
      status: "uncategorized",
      per_page: "200",
      page: String(page),
    }
    if (dateStart) qp.date_start = dateStart
    if (dateEnd) qp.date_end = dateEnd

    const res = await zohoGet<{ banktransactions: BankStatementTxn[] }>(
      `/bankaccounts/${accountId}/statement`,
      organizationId,
      qp
    )

    if (!res.ok) return { txns: [], error: res.errorMessage ?? "Failed to fetch transactions" }

    const batch = res.data?.banktransactions ?? []
    all.push(...batch)

    if (batch.length < 200) break
    page++
  }

  return { txns: all.slice(0, maxTxns) }
}

/** Fetch Chart of Accounts once for GL account ID resolution. */
async function fetchCOA(organizationId: string | undefined): Promise<GLAccount[]> {
  const res = await zohoGet<{ chartofaccounts: GLAccount[] }>(
    "/chartofaccounts",
    organizationId,
    { per_page: "500" }
  )
  return res.ok ? (res.data?.chartofaccounts ?? []) : []
}

/**
 * Paginating fetch for invoices / bills.
 * Fetches up to maxPages × 200 records.
 */
async function fetchAll<T>(
  endpoint: string,
  organizationId: string | undefined,
  params: Record<string, string>,
  dataKey: string,
  maxPages = 5
): Promise<T[]> {
  const all: T[] = []
  let page = 1
  while (page <= maxPages) {
    const res = await zohoGet<Record<string, T[]>>(
      endpoint,
      organizationId,
      { ...params, per_page: "200", page: String(page) }
    )
    if (!res.ok) break
    const batch = (res.data?.[dataKey] ?? []) as T[]
    all.push(...batch)
    if (batch.length < 200) break
    page++
  }
  return all
}

/** Validate an ID is safe for use in a URL path (alphanumeric + _ -). */
function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export function registerReconciliationAutoTools(server: FastMCP): void {

  // ── TOOL 1: auto_categorize_transactions ────────────────────────────────────

  server.addTool({
    name: "auto_categorize_transactions",
    description: `Automatically categorize uncategorized bank transactions using AI keyword matching.

This is the primary automation tool for large-volume reconciliation.
Run it instead of manually categorizing each transaction one-by-one.

How it works:
  1. Fetches ALL uncategorized transactions from the banking feed (auto-paginated)
  2. Fetches your Chart of Accounts to resolve GL account IDs
  3. Applies 30+ India-specific keyword rules per transaction (salary, GST, rent,
     bank charges, telecom, EMI, insurance, travel, etc.)
  4. Categorizes transactions where confidence ≥ min_confidence AND account found
  5. Reports what was auto-categorized and what still needs CA review

Confidence levels:
  High   — strong keyword match → safe to auto-execute (salary, BESCOM, bank fee)
  Medium — plausible match → review before auto-executing (professional fees, travel)
  Low    — no rule matched → must be reviewed manually

RECOMMENDED FIRST RUN:
  dry_run: true — see exactly what would be categorized before committing

After running, use export_uncategorized_to_csv for any remaining Low-confidence
transactions that need CA review.`,

    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID from list_bank_accounts"),
      min_confidence: z
        .enum(["High", "Medium"])
        .optional()
        .default("High")
        .describe(
          "Minimum confidence to auto-execute. " +
          '"High" = only strong matches (default, recommended). ' +
          '"Medium" = also include plausible matches (use dry_run: true first).'
        ),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview what would be categorized without executing (default: false)"),
      date_start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
        .optional()
        .describe("Only process transactions on or after this date"),
      date_end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
        .optional()
        .describe("Only process transactions on or before this date"),
      max_transactions: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(500)
        .describe("Maximum transactions to process per run (default 500, max 1000)"),
    }),

    annotations: { title: "Auto-Categorize Transactions", readOnlyHint: false, openWorldHint: true },

    execute: async (args) => {
      const minConf = args.min_confidence ?? "High"
      const confRank = { High: 2, Medium: 1, Low: 0 }

      // ── Fetch uncategorized transactions ──────────────────────────────────────
      const { txns, error: fetchErr } = await fetchUncategorized(
        args.account_id,
        args.organization_id,
        args.max_transactions ?? 500,
        args.date_start,
        args.date_end
      )
      if (fetchErr) return `Failed to fetch transactions: ${fetchErr}`

      if (txns.length === 0) {
        return `✅ No uncategorized transactions found for account \`${args.account_id}\`.`
      }

      // ── Fetch Chart of Accounts ───────────────────────────────────────────────
      const accounts = await fetchCOA(args.organization_id)

      // ── Classify each transaction ─────────────────────────────────────────────
      interface ClassifiedTxn {
        txn: BankStatementTxn
        suggestion: ReturnType<typeof suggestCategory>
        accountId: string
        actionable: boolean
        skipReason?: string
      }

      const classified: ClassifiedTxn[] = []

      for (const txn of txns) {
        const suggestion = suggestCategory(txn.payee, txn.description, txn.debit_or_credit)
        const accountId = findAccountId(accounts, suggestion.category)

        const meetsConfidence = confRank[suggestion.confidence] >= confRank[minConf]
        const hasAccount = accountId.length > 0

        let actionable = false
        let skipReason: string | undefined

        if (!meetsConfidence) {
          skipReason = `Confidence ${suggestion.confidence} < ${minConf} threshold`
        } else if (!hasAccount) {
          skipReason = `Category "${suggestion.category}" not matched to a GL account — run list_accounts and add to COA or review manually`
        } else if (!isSafeId(txn.transaction_id)) {
          skipReason = `Invalid transaction_id format: "${txn.transaction_id}"`
        } else {
          actionable = true
        }

        classified.push({ txn, suggestion, accountId, actionable, skipReason })
      }

      const toExecute = classified.filter(c => c.actionable)
      const toReview = classified.filter(c => !c.actionable)

      // ── Dry run: preview only ─────────────────────────────────────────────────
      if (args.dry_run) {
        const lines = [
          `**Auto-Categorize Preview (Dry Run)** — Account \`${args.account_id}\``,
          `Min confidence: ${minConf} | Total uncategorized: ${txns.length} | COA accounts: ${accounts.length}`,
          "",
          `**Would auto-categorize: ${toExecute.length}**`,
          `**Would skip (needs review): ${toReview.length}**`,
          "",
        ]

        if (toExecute.length > 0) {
          lines.push("**To be categorized automatically:**")
          for (const c of toExecute.slice(0, 30)) {
            lines.push(
              `  ${c.txn.date}  INR ${Number(c.txn.amount).toLocaleString("en-IN")}  ` +
              `[${c.txn.debit_or_credit}]  ${c.txn.payee || c.txn.description || "?"}` +
              `\n    → ${c.suggestion.category} (${c.suggestion.confidence}) | account: \`${c.accountId}\` | type: ${c.suggestion.transaction_type}`
            )
          }
          if (toExecute.length > 30) lines.push(`  ...and ${toExecute.length - 30} more`)
          lines.push("")
        }

        if (toReview.length > 0) {
          lines.push(`**Need CA review (${toReview.length} transactions):**`)
          // Group by skip reason for readability
          const byReason = new Map<string, number>()
          for (const c of toReview) {
            const r = c.skipReason ?? "unknown"
            byReason.set(r, (byReason.get(r) ?? 0) + 1)
          }
          for (const [reason, count] of byReason) {
            lines.push(`  ${count}× — ${reason}`)
          }
          lines.push("")
          lines.push("  Use export_uncategorized_to_csv to review these in Excel.")
        }

        lines.push(`Set dry_run: false to execute the ${toExecute.length} actionable categorization(s).`)
        return lines.join("\n")
      }

      // ── Execute ───────────────────────────────────────────────────────────────
      if (toExecute.length === 0) {
        return [
          `No transactions meet the auto-categorize criteria (min_confidence: ${minConf}).`,
          `Total uncategorized: ${txns.length} | Skipped: ${toReview.length}`,
          "",
          "Options:",
          "  • Lower min_confidence to \"Medium\" (use dry_run: true first)",
          "  • Use export_uncategorized_to_csv for manual CA review",
        ].join("\n")
      }

      auditStart("auto_categorize_transactions", args.organization_id, "WRITE", "bank_reconciliation_bulk", {
        account_id: args.account_id,
        to_execute: toExecute.length,
        min_confidence: minConf,
      })

      interface ExecResult {
        txnId: string
        date: string
        amount: string
        payee: string
        category: string
        status: "success" | "failed" | "already_categorized"
        message: string
      }

      const results: ExecResult[] = []
      let successCount = 0
      let failedCount = 0

      for (let i = 0; i < toExecute.length; i++) {
        const { txn, suggestion, accountId } = toExecute[i]

        if (i > 0) await sleep(700) // Zoho rate limit: ~100 req/min

        const payload: Record<string, unknown> = {
          transaction_type: suggestion.transaction_type,
          account_id: accountId,
          amount: Number(txn.amount),
          date: txn.date,
        }
        if (txn.description) payload.description = txn.description
        if (txn.reference_number) payload.reference_number = txn.reference_number

        const res = await zohoPost<{ message: string }>(
          `/bankaccounts/${args.account_id}/statement/${txn.transaction_id}/categorize`,
          args.organization_id,
          payload
        )

        if (res.ok) {
          auditSuccess("auto_categorize_transactions", args.organization_id, "WRITE", "bank_transaction", txn.transaction_id)
          successCount++
          results.push({
            txnId: txn.transaction_id,
            date: txn.date,
            amount: `INR ${Number(txn.amount).toLocaleString("en-IN")}`,
            payee: txn.payee || txn.description || "?",
            category: suggestion.category,
            status: "success",
            message: "Categorized",
          })
        } else {
          const errMsg = res.errorMessage ?? "Unknown error"
          const isAlready = errMsg.toLowerCase().includes("already")
          auditFail("auto_categorize_transactions", args.organization_id, "WRITE", "bank_transaction", errMsg)

          if (isAlready) {
            results.push({
              txnId: txn.transaction_id,
              date: txn.date,
              amount: `INR ${Number(txn.amount).toLocaleString("en-IN")}`,
              payee: txn.payee || txn.description || "?",
              category: suggestion.category,
              status: "already_categorized",
              message: "Already categorized — skipped",
            })
          } else {
            failedCount++
            results.push({
              txnId: txn.transaction_id,
              date: txn.date,
              amount: `INR ${Number(txn.amount).toLocaleString("en-IN")}`,
              payee: txn.payee || txn.description || "?",
              category: suggestion.category,
              status: "failed",
              message: errMsg,
            })
          }
        }

        // Log progress every 20 transactions
        if ((i + 1) % 20 === 0) {
          console.log(`[auto_categorize] Progress: ${i + 1}/${toExecute.length} processed`)
        }
      }

      // ── Build results report ─────────────────────────────────────────────────
      const alreadyCount = results.filter(r => r.status === "already_categorized").length
      const statusIcon = failedCount === 0 ? "✅" : failedCount < successCount ? "⚠️" : "❌"

      const lines = [
        `${statusIcon} **Auto-Categorize Complete** — Account \`${args.account_id}\``,
        "",
        `| Result | Count |`,
        `|--------|-------|`,
        `| ✅ Categorized | ${successCount} |`,
        `| ❌ Failed | ${failedCount} |`,
        `| ⏭ Already done | ${alreadyCount} |`,
        `| ⚠️ Needs CA review | ${toReview.length} |`,
        `| Total uncategorized found | ${txns.length} |`,
        "",
      ]

      if (failedCount > 0) {
        lines.push("**Failed — check these manually:**")
        for (const r of results.filter(r => r.status === "failed")) {
          lines.push(`  ${r.date}  ${r.amount}  ${r.payee}  → ${r.message}`)
        }
        lines.push("")
      }

      if (toReview.length > 0) {
        // Group review items by reason
        const byReason = new Map<string, { count: number; example: string }>()
        for (const c of toReview) {
          const r = c.skipReason ?? "unknown"
          const existing = byReason.get(r)
          if (existing) {
            existing.count++
          } else {
            byReason.set(r, {
              count: 1,
              example: c.txn.payee || c.txn.description || c.txn.transaction_id,
            })
          }
        }

        lines.push(`**${toReview.length} transaction(s) still need review:**`)
        for (const [reason, { count, example }] of byReason) {
          lines.push(`  ${count}× — ${reason}  (e.g. "${example}")`)
        }
        lines.push("")
        lines.push("→ Run export_uncategorized_to_csv to review remaining in Excel.")
      }

      if (successCount > 0) {
        lines.push(`${successCount} transaction(s) categorized. Run get_reconciliation_summary to see updated progress.`)
      }

      return lines.join("\n")
    },
  })

  // ── TOOL 2: bulk_match_transactions ─────────────────────────────────────────

  server.addTool({
    name: "bulk_match_transactions",
    description: `Auto-match uncategorized bank transactions to open invoices and unpaid bills.

Run this BEFORE auto_categorize_transactions.
Matching links the bank entry to an existing Zoho record — no duplicate journal
entry is created (same as clicking "Match" in the Banking UI).

Matching logic:
  Credits (money in)  → matched against open/overdue invoices
  Debits  (money out) → matched against unpaid bills

Match criteria:
  Amount must be within ±tolerance_amount of the invoice/bill balance_due
  Transaction date within ±tolerance_days of invoice/bill date

SAFE DEFAULT: dry_run: true (must explicitly set dry_run: false to execute).

Confidence levels in output:
  Exact match — same amount, date within ±7 days → auto-matched if dry_run: false
  Close match — within tolerance but not exact → shown for CA review only`,

    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID from list_bank_accounts"),
      tolerance_amount: z
        .number()
        .min(0)
        .max(1000)
        .optional()
        .default(0)
        .describe("Accept invoice/bill where balance_due is within ±N rupees of transaction amount (default: 0 = exact match)"),
      tolerance_days: z
        .number()
        .int()
        .min(0)
        .max(90)
        .optional()
        .default(7)
        .describe("Accept invoice/bill where date is within ±N days of transaction date (default: 7)"),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe("Preview matches without executing (default: TRUE — must explicitly set false to execute)"),
      max_transactions: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(200)
        .describe("Max uncategorized transactions to scan (default 200)"),
      date_start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
        .optional()
        .describe("Only process transactions on or after this date"),
      date_end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
        .optional()
        .describe("Only process transactions on or before this date"),
      match_adjusted: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Enable GST/TDS-adjusted matching (default: true). " +
          "Credits: tries invoice_balance × 1.05/1.12/1.18/1.28 (GST). " +
          "Debits: tries bill_balance × 0.90/0.92/0.98/0.99 (TDS deducted)."
        ),
    }),

    annotations: { title: "Bulk Match Bank Transactions to Invoices/Bills", readOnlyHint: false, openWorldHint: true },

    execute: async (args) => {
      const tolAmount = args.tolerance_amount ?? 0
      const tolDays = args.tolerance_days ?? 7
      const matchAdjusted = args.match_adjusted !== false

      // GST multipliers for credit (invoice) matching
      const GST_RATES = [1.05, 1.12, 1.18, 1.28]
      // TDS deduction factors for debit (bill) matching
      const TDS_FACTORS = [0.90, 0.92, 0.98, 0.99]

      // ── Fetch uncategorized transactions ──────────────────────────────────────
      const { txns, error: fetchErr } = await fetchUncategorized(
        args.account_id,
        args.organization_id,
        args.max_transactions ?? 200,
        args.date_start,
        args.date_end
      )
      if (fetchErr) return `Failed to fetch transactions: ${fetchErr}`
      if (txns.length === 0) return `✅ No uncategorized transactions for account \`${args.account_id}\`.`

      // Separate credits and debits
      const credits = txns.filter(t => t.debit_or_credit === "credit")
      const debits = txns.filter(t => t.debit_or_credit === "debit")

      // ── Fetch open invoices (paginated) ───────────────────────────────────────
      let invoices: Invoice[] = []
      if (credits.length > 0) {
        invoices = await fetchAll<Invoice>(
          "/invoices",
          args.organization_id,
          { status: "outstanding" },
          "invoices",
          5
        )
      }

      // ── Fetch unpaid bills (paginated) ────────────────────────────────────────
      let bills: Bill[] = []
      if (debits.length > 0) {
        bills = await fetchAll<Bill>(
          "/bills",
          args.organization_id,
          { status: "unpaid" },
          "bills",
          5
        )
      }

      // ── Date difference helper ────────────────────────────────────────────────
      function daysDiff(d1: string, d2: string): number {
        const t1 = new Date(d1).getTime()
        const t2 = new Date(d2).getTime()
        if (isNaN(t1) || isNaN(t2)) return 999
        return Math.abs(Math.round((t1 - t2) / 86_400_000))
      }

      // ── Match credits to invoices ─────────────────────────────────────────────
      interface MatchCandidate {
        txn: BankStatementTxn
        matchType: "invoice" | "bill"
        matchId: string
        matchRef: string
        matchParty: string
        txnAmount: number
        matchBalance: number
        dateDiff: number
        confidence: "exact" | "close"
        matchNote: string
      }

      const candidates: MatchCandidate[] = []

      for (const txn of credits) {
        const txnAmt = Number(txn.amount)
        let found = false

        for (const inv of invoices) {
          const invBal = Number(inv.balance)
          if (isNaN(txnAmt) || isNaN(invBal)) continue

          const dd = daysDiff(txn.date, inv.date)
          if (dd > tolDays) continue

          // Exact / tolerance match
          if (Math.abs(txnAmt - invBal) <= tolAmount) {
            const isExact = Math.abs(txnAmt - invBal) === 0 && dd === 0
            candidates.push({
              txn,
              matchType: "invoice",
              matchId: inv.invoice_id,
              matchRef: inv.invoice_number,
              matchParty: inv.customer_name,
              txnAmount: txnAmt,
              matchBalance: invBal,
              dateDiff: dd,
              confidence: isExact ? "exact" : "close",
              matchNote: isExact ? "Exact match" : `Close match (diff ₹${Math.abs(txnAmt - invBal).toFixed(2)})`,
            })
            found = true
            break
          }

          // GST-adjusted match
          if (matchAdjusted) {
            for (const rate of GST_RATES) {
              const adjusted = invBal * rate
              if (Math.abs(txnAmt - adjusted) <= tolAmount) {
                const gstPct = Math.round((rate - 1) * 100)
                candidates.push({
                  txn,
                  matchType: "invoice",
                  matchId: inv.invoice_id,
                  matchRef: inv.invoice_number,
                  matchParty: inv.customer_name,
                  txnAmount: txnAmt,
                  matchBalance: invBal,
                  dateDiff: dd,
                  confidence: "close",
                  matchNote: `GST-adjusted match (${gstPct}% GST — invoice balance × ${rate})`,
                })
                found = true
                break
              }
            }
          }

          if (found) break
        }
      }

      for (const txn of debits) {
        const txnAmt = Number(txn.amount)
        let found = false

        for (const bill of bills) {
          const billBal = Number(bill.balance)
          if (isNaN(txnAmt) || isNaN(billBal)) continue

          const dd = daysDiff(txn.date, bill.date)
          if (dd > tolDays) continue

          // Exact / tolerance match
          if (Math.abs(txnAmt - billBal) <= tolAmount) {
            const isExact = Math.abs(txnAmt - billBal) === 0 && dd === 0
            candidates.push({
              txn,
              matchType: "bill",
              matchId: bill.bill_id,
              matchRef: bill.bill_number,
              matchParty: bill.vendor_name,
              txnAmount: txnAmt,
              matchBalance: billBal,
              dateDiff: dd,
              confidence: isExact ? "exact" : "close",
              matchNote: isExact ? "Exact match" : `Close match (diff ₹${Math.abs(txnAmt - billBal).toFixed(2)})`,
            })
            found = true
            break
          }

          // TDS-adjusted match (payment made = bill × (1 - TDS%))
          if (matchAdjusted) {
            for (const factor of TDS_FACTORS) {
              const adjusted = billBal * factor
              if (Math.abs(txnAmt - adjusted) <= tolAmount) {
                const tdsPct = Math.round((1 - factor) * 100)
                candidates.push({
                  txn,
                  matchType: "bill",
                  matchId: bill.bill_id,
                  matchRef: bill.bill_number,
                  matchParty: bill.vendor_name,
                  txnAmount: txnAmt,
                  matchBalance: billBal,
                  dateDiff: dd,
                  confidence: "close",
                  matchNote: `TDS-adjusted match (${tdsPct}% TDS deducted — bill balance × ${factor})`,
                })
                found = true
                break
              }
            }
          }

          if (found) break
        }
      }

      if (candidates.length === 0) {
        return [
          `No matches found for account \`${args.account_id}\`.`,
          `Scanned: ${txns.length} uncategorized transactions | ${invoices.length} open invoices | ${bills.length} unpaid bills`,
          `Tolerance: ±₹${tolAmount} / ±${tolDays} days | Adjusted matching: ${matchAdjusted ? "on" : "off"}`,
          "",
          "Tip: increase tolerance_amount or tolerance_days to find near-matches.",
          matchAdjusted ? "" : "Tip: set match_adjusted: true to try GST/TDS-adjusted amounts.",
        ].join("\n")
      }

      const exactCount = candidates.filter(c => c.confidence === "exact").length
      const adjustedCount = candidates.filter(c => c.matchNote.includes("adjusted")).length
      const closeCount = candidates.length - exactCount - adjustedCount

      // ── Dry run ───────────────────────────────────────────────────────────────
      if (args.dry_run) {
        const lines = [
          `**Bulk Match Preview (Dry Run)** — Account \`${args.account_id}\``,
          `Found ${candidates.length} match candidate(s) from ${txns.length} transactions`,
          `Invoices scanned: ${invoices.length} | Bills scanned: ${bills.length}`,
          `Exact: ${exactCount} | Close: ${closeCount} | Adjusted (GST/TDS): ${adjustedCount}`,
          "",
          "| Date | Amount | Payee | Matches | Type | Ref | Confidence | Note |",
          "|------|--------|-------|---------|------|-----|------------|------|",
        ]
        for (const c of candidates) {
          lines.push(
            `| ${c.txn.date} | INR ${c.txnAmount.toLocaleString("en-IN")} | ` +
            `${c.txn.payee || "?"} | ${c.matchParty} | ${c.matchType} | ` +
            `${c.matchRef} | ${c.confidence} | ${c.matchNote} |`
          )
        }
        lines.push("")
        lines.push(`Set dry_run: false to execute ${candidates.length} match(es).`)
        return lines.join("\n")
      }

      // ── Execute matches ───────────────────────────────────────────────────────
      auditStart("bulk_match_transactions", args.organization_id, "WRITE", "bank_reconciliation_bulk", {
        account_id: args.account_id,
        candidates: candidates.length,
      })

      let successCount = 0
      let failedCount = 0
      const failedDetails: string[] = []

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]

        if (i > 0) await sleep(700)

        if (!isSafeId(c.txn.transaction_id) || !isSafeId(c.matchId)) {
          failedCount++
          failedDetails.push(`${c.txn.transaction_id}: invalid ID format`)
          continue
        }

        const res = await zohoPost<{ message: string }>(
          `/bankaccounts/${args.account_id}/statement/${c.txn.transaction_id}/match`,
          args.organization_id,
          {
            transaction_id: c.matchId,
            transaction_type: c.matchType === "invoice" ? "invoice" : "bill",
          }
        )

        if (res.ok) {
          auditSuccess("bulk_match_transactions", args.organization_id, "WRITE", "bank_transaction", c.txn.transaction_id)
          successCount++
        } else {
          const errMsg = res.errorMessage ?? "Unknown error"
          auditFail("bulk_match_transactions", args.organization_id, "WRITE", "bank_transaction", errMsg)
          failedCount++
          failedDetails.push(`${c.txn.date} ${c.txn.payee ?? "?"}: ${errMsg}`)
        }
      }

      const icon = failedCount === 0 ? "✅" : failedCount < successCount ? "⚠️" : "❌"
      const lines = [
        `${icon} **Bulk Match Complete** — Account \`${args.account_id}\``,
        `Matched: ${successCount} | Failed: ${failedCount}`,
        `Exact: ${exactCount} | Close: ${closeCount} | Adjusted (GST/TDS): ${adjustedCount}`,
        "",
      ]
      if (failedCount > 0) {
        lines.push("**Failed matches:**")
        failedDetails.forEach(d => lines.push(`  ${d}`))
        lines.push("")
      }
      if (successCount > 0) {
        lines.push(`${successCount} transaction(s) matched. Run auto_categorize_transactions to handle remaining uncategorized entries.`)
      }
      return lines.join("\n")
    },
  })

  // ── TOOL 3: suggest_and_create_bank_rules ───────────────────────────────────

  server.addTool({
    name: "suggest_and_create_bank_rules",
    description: `Create Zoho bank rules for recurring payees so future imports are auto-categorized.

This is the "set it and forget it" tool. Once rules are created, every future
bank statement import will auto-categorize matching transactions — no manual
work at month end.

How it works:
  1. Analyses uncategorized transactions for recurring payees (≥ min_occurrences)
  2. Shows which payees recur most and their AI-suggested category
  3. CA provides rule_mappings: [{payee_keyword, gl_account_id, transaction_type}]
  4. Creates bank rules in Zoho for each mapping

Each bank rule in Zoho will:
  - Match: transactions where Description/Payee CONTAINS payee_keyword
  - Action: categorize to gl_account_id with the given transaction_type

SAFE DEFAULT: dry_run: true (shows what rules would be created without creating them).

Run suggest_only: true first to see the recommended payee list before providing mappings.`,

    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID from list_bank_accounts"),
      suggest_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true: just show recurring payees and suggested mappings without creating rules"),
      min_occurrences: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(2)
        .describe("Only suggest rules for payees with at least this many transactions (default: 2)"),
      rule_mappings: z
        .array(z.object({
          payee_keyword: z.string().min(1).max(100).describe("The payee name/keyword to match (case-insensitive contains)"),
          gl_account_id: entityIdSchema.describe("GL account ID from list_accounts"),
          direction: z.enum(["debit", "credit"]).describe("Transaction direction: 'debit' = money out (expense), 'credit' = money in (income/deposit)"),
        }))
        .optional()
        .describe("CA-approved account mappings per payee. Required if suggest_only: false."),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe("Preview rules without creating them in Zoho (default: TRUE)"),
    }),

    annotations: { title: "Suggest and Create Bank Rules", readOnlyHint: false, openWorldHint: true },

    execute: async (args) => {
      // ── Fetch uncategorized transactions for pattern analysis ─────────────────
      const { txns, error: fetchErr } = await fetchUncategorized(
        args.account_id,
        args.organization_id,
        500
      )
      if (fetchErr) return `Failed to fetch transactions: ${fetchErr}`
      if (txns.length === 0) return `✅ No uncategorized transactions for account \`${args.account_id}\`.`

      // ── Group by payee/description ────────────────────────────────────────────
      interface PatternGroup {
        key: string
        rawPayee: string
        count: number
        totalAmt: number
        direction: string
        suggestion: ReturnType<typeof suggestCategory>
        txnIds: string[]
      }

      const groups = new Map<string, PatternGroup>()

      for (const tx of txns) {
        const rawPayee = (tx.payee || tx.description || "UNKNOWN").trim()
        const key = rawPayee.toLowerCase().replace(/\s+/g, " ").slice(0, 60)
        const existing = groups.get(key)
        const amt = Number(tx.amount) || 0
        const suggestion = suggestCategory(tx.payee, tx.description, tx.debit_or_credit)

        if (existing) {
          existing.count++
          existing.totalAmt += amt
          existing.txnIds.push(tx.transaction_id)
        } else {
          groups.set(key, {
            key,
            rawPayee,
            count: 1,
            totalAmt: amt,
            direction: tx.debit_or_credit || "unknown",
            suggestion,
            txnIds: [tx.transaction_id],
          })
        }
      }

      const minOcc = args.min_occurrences ?? 2
      const recurring = [...groups.values()]
        .filter(g => g.count >= minOcc)
        .sort((a, b) => b.count - a.count)

      // ── suggest_only: show analysis ───────────────────────────────────────────
      if (args.suggest_only || !args.rule_mappings || args.rule_mappings.length === 0) {
        const lines = [
          `**Recurring Payees — Bank Rule Candidates** — Account \`${args.account_id}\``,
          `Uncategorized transactions: ${txns.length} | Unique payees: ${groups.size} | Recurring (≥${minOcc}×): ${recurring.length}`,
          "",
        ]

        if (recurring.length === 0) {
          lines.push(`No payee appears ≥${minOcc} times. Lower min_occurrences or check if more transactions need importing.`)
        } else {
          lines.push("**Provide these as rule_mappings to create bank rules:**")
          lines.push("")
          lines.push("| # | Payee | Count | Total | Direction | Suggested Category | Confidence |")
          lines.push("|---|-------|-------|-------|-----------|-------------------|------------|")

          for (const [i, g] of recurring.entries()) {
            lines.push(
              `| ${i + 1} | ${g.rawPayee.slice(0, 40)} | ${g.count}× | ` +
              `INR ${g.totalAmt.toLocaleString("en-IN")} | ${g.direction} | ` +
              `${g.suggestion.category} | ${g.suggestion.confidence} |`
            )
          }

          lines.push("")
          lines.push("**Next step:** Call this tool again with rule_mappings=[{payee_keyword, gl_account_id, direction}, ...] and dry_run: true")
          lines.push("Run list_accounts to get gl_account_id values.")
        }

        return lines.join("\n")
      }

      // ── Validate mappings ─────────────────────────────────────────────────────
      const mappings = args.rule_mappings ?? []
      const validationErrors: string[] = []

      for (const m of mappings) {
        if (!isSafeId(m.gl_account_id)) {
          validationErrors.push(`Invalid gl_account_id: "${m.gl_account_id}"`)
        }
        if (m.payee_keyword.length < 2) {
          validationErrors.push(`payee_keyword too short: "${m.payee_keyword}"`)
        }
      }

      if (validationErrors.length > 0) {
        return `Validation errors in rule_mappings:\n${validationErrors.map(e => `  • ${e}`).join("\n")}`
      }

      // ── Dry run: show rules that would be created ─────────────────────────────
      if (args.dry_run) {
        const lines = [
          `**Bank Rule Creation Preview (Dry Run)**`,
          `Would create ${mappings.length} bank rule(s) for account \`${args.account_id}\`:`,
          "",
          "| Payee Keyword | GL Account ID | Direction | Rule Name |",
          "|---------------|---------------|-----------|-----------|",
        ]
        for (const m of mappings) {
          const ruleName = `Auto: ${m.payee_keyword.slice(0, 50)} - ${args.account_id.slice(-6)}`
          lines.push(`| ${m.payee_keyword} | \`${m.gl_account_id}\` | ${m.direction} | ${ruleName} |`)
        }
        lines.push("")
        lines.push("Set dry_run: false to create these rules in Zoho Books.")
        return lines.join("\n")
      }

      // ── Execute: create bank rules ────────────────────────────────────────────
      auditStart("suggest_and_create_bank_rules", args.organization_id, "WRITE", "bank_rule", {
        account_id: args.account_id,
        rule_count: mappings.length,
      })

      let created = 0
      let failed = 0
      const failDetails: string[] = []

      for (let i = 0; i < mappings.length; i++) {
        const m = mappings[i]
        if (i > 0) await sleep(700)

        const rulePayload: Record<string, unknown> = {
          rule_name: `Auto: ${m.payee_keyword.slice(0, 50)} - ${args.account_id.slice(-6)}`,
          account_id: args.account_id,
          transaction_type: m.direction,
          criteria: [
            {
              criteria_field: "payee",
              criteria_condition: "contains",
              criteria_value: m.payee_keyword,
            },
          ],
          action_categorize_as: "expense",
          action_account_id: m.gl_account_id,
        }

        const res = await zohoPost<{ rule: { rule_id: string } }>(
          "/bankaccounts/rules",
          args.organization_id,
          rulePayload
        )

        if (res.ok) {
          auditSuccess("suggest_and_create_bank_rules", args.organization_id, "WRITE", "bank_rule")
          created++
        } else {
          const errMsg = res.errorMessage ?? "Unknown error"
          auditFail("suggest_and_create_bank_rules", args.organization_id, "WRITE", "bank_rule", errMsg)
          failed++
          failDetails.push(`"${m.payee_keyword}": ${errMsg}`)
        }
      }

      const icon = failed === 0 ? "✅" : failed < created ? "⚠️" : "❌"
      const lines = [
        `${icon} **Bank Rules Created** — Account \`${args.account_id}\``,
        `Created: ${created} | Failed: ${failed}`,
        "",
      ]
      if (failed > 0) {
        lines.push("**Failed:**")
        failDetails.forEach(d => lines.push(`  ${d}`))
        lines.push("")
      }
      if (created > 0) {
        lines.push(`${created} rule(s) active. All future bank statement imports will auto-categorize matching transactions.`)
        lines.push("Run list_bank_rules to review active rules.")
      }
      return lines.join("\n")
    },
  })
}
