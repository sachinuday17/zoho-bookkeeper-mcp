/**
 * Reconciliation Pipeline — Master Orchestrator
 *
 * TOOL 1: reconcile_account
 *   Master orchestrator — runs all reconciliation phases in sequence:
 *     Phase 1: Match credits→invoices (exact + GST-adjusted)
 *              Match debits→bills (exact + TDS-adjusted)
 *     Phase 2: AI auto-categorize remaining High/Medium-confidence transactions
 *     Phase 3: Report remaining items needing CA review
 *
 * TOOL 2: verify_reconciliation
 *   Quick status dashboard after running reconcile_account.
 *   Shows total/categorized/uncategorized counts, progress bar, and balance.
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

interface BankAccount {
  account_id: string
  account_name: string
  current_balance?: number | string
  account_type?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

/** Fetch all uncategorized transactions, auto-paginating. */
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

/** Fetch all statement transactions (for verify status). */
async function fetchAllStatement(
  accountId: string,
  organizationId: string | undefined,
  status: string
): Promise<BankStatementTxn[]> {
  const res = await zohoGet<{ banktransactions: BankStatementTxn[] }>(
    `/bankaccounts/${accountId}/statement`,
    organizationId,
    { status, per_page: "200", page: "1" }
  )
  return res.ok ? (res.data?.banktransactions ?? []) : []
}

/** Paginating fetch for invoices / bills. */
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

/** Fetch Chart of Accounts. */
async function fetchCOA(organizationId: string | undefined): Promise<GLAccount[]> {
  const res = await zohoGet<{ chartofaccounts: GLAccount[] }>(
    "/chartofaccounts",
    organizationId,
    { per_page: "500" }
  )
  return res.ok ? (res.data?.chartofaccounts ?? []) : []
}

function daysDiff(d1: string, d2: string): number {
  const t1 = new Date(d1).getTime()
  const t2 = new Date(d2).getTime()
  if (isNaN(t1) || isNaN(t2)) return 999
  return Math.abs(Math.round((t1 - t2) / 86_400_000))
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export function registerReconciliationPipelineTools(server: FastMCP): void {

  // ── TOOL 1: reconcile_account ───────────────────────────────────────────────

  server.addTool({
    name: "reconcile_account",
    description: `Master reconciliation orchestrator — runs all phases in one call.

Recommended as the FIRST command when opening a client's books each month.

Phase 1 — MATCH (runs first, highest precision):
  Credits matched to open invoices (exact + GST-adjusted: 5%/12%/18%/28%)
  Debits matched to unpaid bills (exact + TDS-adjusted: 10%/8%/2%/1% deducted)

Phase 2 — AI AUTO-CATEGORIZE (runs on remaining uncategorized):
  Applies India keyword rules (salary, GST, rent, bank charges, etc.)
  Only categorizes transactions at or above min_confidence threshold

Phase 3 — REPORT:
  Shows what was cleared and what still needs CA review

ALWAYS run dry_run: true first (the default) to preview the full plan.
Set dry_run: false only after reviewing the preview.`,

    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID from list_bank_accounts"),
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
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe("Preview all phases without executing (default: TRUE — always preview first)"),
      match_adjusted: z
        .boolean()
        .optional()
        .default(true)
        .describe("Enable GST/TDS-adjusted matching in Phase 1 (default: true)"),
      auto_categorize_confidence: z
        .enum(["High", "Medium"])
        .optional()
        .default("High")
        .describe("Minimum confidence for Phase 2 auto-categorization (default: High)"),
      tolerance_days: z
        .number()
        .int()
        .min(0)
        .max(90)
        .optional()
        .default(7)
        .describe("Phase 1: date window for invoice/bill matching ±N days (default: 7)"),
      tolerance_amount: z
        .number()
        .min(0)
        .max(1000)
        .optional()
        .default(0)
        .describe("Phase 1: amount tolerance ±N rupees for matching (default: 0 = exact)"),
    }),

    annotations: { title: "Reconcile Account (Full Pipeline)", readOnlyHint: false, openWorldHint: true },

    execute: async (args) => {
      const tolAmount = args.tolerance_amount ?? 0
      const tolDays = args.tolerance_days ?? 7
      const matchAdjusted = args.match_adjusted !== false
      const minConf = args.auto_categorize_confidence ?? "High"
      const confRank = { High: 2, Medium: 1, Low: 0 }

      const GST_RATES = [1.05, 1.12, 1.18, 1.28]
      const TDS_FACTORS = [0.90, 0.92, 0.98, 0.99]

      let apiCallCount = 0
      const MAX_API_CALLS = 1000
      const checkApiLimit = (label: string): string | null => {
        if (apiCallCount >= MAX_API_CALLS) {
          return `Safety limit reached: ${MAX_API_CALLS} API calls. Stopping at: ${label}. Run again to continue from where it stopped.`
        }
        return null
      }

      // ── Fetch uncategorized transactions ────────────────────────────────────
      apiCallCount++
      const { txns, error: fetchErr } = await fetchUncategorized(
        args.account_id,
        args.organization_id,
        1000,
        args.date_start,
        args.date_end
      )
      if (fetchErr) return `Failed to fetch transactions: ${fetchErr}`
      if (txns.length === 0) {
        return `No uncategorized transactions found for account \`${args.account_id}\`. Account may already be fully reconciled. Run verify_reconciliation to confirm.`
      }

      const credits = txns.filter(t => t.debit_or_credit === "credit")
      const debits  = txns.filter(t => t.debit_or_credit === "debit")

      // ── Fetch invoices and bills ────────────────────────────────────────────
      let invoices: Invoice[] = []
      if (credits.length > 0) {
        apiCallCount++
        invoices = await fetchAll<Invoice>("/invoices", args.organization_id, { status: "outstanding" }, "invoices", 5)
      }

      let bills: Bill[] = []
      if (debits.length > 0) {
        apiCallCount++
        bills = await fetchAll<Bill>("/bills", args.organization_id, { status: "unpaid" }, "bills", 5)
      }

      // ── Fetch COA ───────────────────────────────────────────────────────────
      apiCallCount++
      const accounts = await fetchCOA(args.organization_id)

      // ─────────────────────────────────────────────────────────────────────────
      // PHASE 1 — MATCH
      // ─────────────────────────────────────────────────────────────────────────

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

      const matchCandidates: MatchCandidate[] = []

      // Credits → Invoices
      for (const txn of credits) {
        const txnAmt = Number(txn.amount)
        let found = false

        for (const inv of invoices) {
          const invBal = Number(inv.balance)
          if (isNaN(txnAmt) || isNaN(invBal)) continue
          const dd = daysDiff(txn.date, inv.date)
          if (dd > tolDays) continue

          if (Math.abs(txnAmt - invBal) <= tolAmount) {
            const isExact = Math.abs(txnAmt - invBal) === 0 && dd === 0
            matchCandidates.push({
              txn, matchType: "invoice", matchId: inv.invoice_id,
              matchRef: inv.invoice_number, matchParty: inv.customer_name,
              txnAmount: txnAmt, matchBalance: invBal, dateDiff: dd,
              confidence: isExact ? "exact" : "close",
              matchNote: isExact ? "Exact match" : `Close match (diff ₹${Math.abs(txnAmt - invBal).toFixed(2)})`,
            })
            found = true
            break
          }

          if (matchAdjusted && !found) {
            for (const rate of GST_RATES) {
              if (Math.abs(txnAmt - invBal * rate) <= tolAmount) {
                const gstPct = Math.round((rate - 1) * 100)
                matchCandidates.push({
                  txn, matchType: "invoice", matchId: inv.invoice_id,
                  matchRef: inv.invoice_number, matchParty: inv.customer_name,
                  txnAmount: txnAmt, matchBalance: invBal, dateDiff: dd,
                  confidence: "close",
                  matchNote: `GST-adjusted (${gstPct}% GST — invoice × ${rate})`,
                })
                found = true
                break
              }
            }
          }

          if (found) break
        }
      }

      // Debits → Bills
      for (const txn of debits) {
        const txnAmt = Number(txn.amount)
        let found = false

        for (const bill of bills) {
          const billBal = Number(bill.balance)
          if (isNaN(txnAmt) || isNaN(billBal)) continue
          const dd = daysDiff(txn.date, bill.date)
          if (dd > tolDays) continue

          if (Math.abs(txnAmt - billBal) <= tolAmount) {
            const isExact = Math.abs(txnAmt - billBal) === 0 && dd === 0
            matchCandidates.push({
              txn, matchType: "bill", matchId: bill.bill_id,
              matchRef: bill.bill_number, matchParty: bill.vendor_name,
              txnAmount: txnAmt, matchBalance: billBal, dateDiff: dd,
              confidence: isExact ? "exact" : "close",
              matchNote: isExact ? "Exact match" : `Close match (diff ₹${Math.abs(txnAmt - billBal).toFixed(2)})`,
            })
            found = true
            break
          }

          if (matchAdjusted && !found) {
            for (const factor of TDS_FACTORS) {
              if (Math.abs(txnAmt - billBal * factor) <= tolAmount) {
                const tdsPct = Math.round((1 - factor) * 100)
                matchCandidates.push({
                  txn, matchType: "bill", matchId: bill.bill_id,
                  matchRef: bill.bill_number, matchParty: bill.vendor_name,
                  txnAmount: txnAmt, matchBalance: billBal, dateDiff: dd,
                  confidence: "close",
                  matchNote: `TDS-adjusted (${tdsPct}% TDS deducted — bill × ${factor})`,
                })
                found = true
                break
              }
            }
          }

          if (found) break
        }
      }

      const p1ExactCredits  = matchCandidates.filter(c => c.matchType === "invoice" && c.confidence === "exact").length
      const p1AdjCredits    = matchCandidates.filter(c => c.matchType === "invoice" && c.matchNote.includes("adjusted")).length
      const p1ExactDebits   = matchCandidates.filter(c => c.matchType === "bill" && c.confidence === "exact").length
      const p1AdjDebits     = matchCandidates.filter(c => c.matchType === "bill" && c.matchNote.includes("adjusted")).length

      // ─────────────────────────────────────────────────────────────────────────
      // PHASE 2 — AI AUTO-CATEGORIZE
      // ─────────────────────────────────────────────────────────────────────────

      interface ClassifiedTxn {
        txn: BankStatementTxn
        suggestion: ReturnType<typeof suggestCategory>
        accountId: string
        actionable: boolean
        skipReason?: string
      }

      // In dry_run: classify all uncategorized (Phase 1 hasn't run yet, so pool is full)
      // In execute: we'll classify all — after Phase 1 runs, those txns are categorized
      //   and the API won't return them in a fresh fetch anyway
      const classified: ClassifiedTxn[] = []

      for (const txn of txns) {
        const suggestion = suggestCategory(txn.payee, txn.description, txn.debit_or_credit)
        const accountId  = findAccountId(accounts, suggestion.category)
        const meetsConf  = confRank[suggestion.confidence] >= confRank[minConf]
        const hasAccount = accountId.length > 0

        let actionable = false
        let skipReason: string | undefined

        if (!meetsConf) {
          skipReason = `Confidence ${suggestion.confidence} < ${minConf}`
        } else if (!hasAccount) {
          skipReason = `GL account not found for "${suggestion.category}"`
        } else if (!isSafeId(txn.transaction_id)) {
          skipReason = `Invalid transaction_id: "${txn.transaction_id}"`
        } else {
          actionable = true
        }

        classified.push({ txn, suggestion, accountId, actionable, skipReason })
      }

      const p2ToExecute = classified.filter(c => c.actionable)
      const p2ToReview  = classified.filter(c => !c.actionable)

      // Phase 2 category breakdown
      const catBreakdown = new Map<string, number>()
      for (const c of p2ToExecute) {
        catBreakdown.set(c.suggestion.category, (catBreakdown.get(c.suggestion.category) ?? 0) + 1)
      }

      // ─────────────────────────────────────────────────────────────────────────
      // DRY RUN — show the plan
      // ─────────────────────────────────────────────────────────────────────────

      if (args.dry_run) {
        const totalAutoCleared = matchCandidates.length + p2ToExecute.length
        const remaining = txns.length - totalAutoCleared

        const lines: string[] = [
          `## Reconciliation Plan — Account \`${args.account_id}\``,
          `Date: ${new Date().toISOString().slice(0, 10)}`,
          `Total uncategorized: ${txns.length} | Credits: ${credits.length} | Debits: ${debits.length}`,
          "",
          "---",
          "",
          "### Phase 1 — Match to Invoices & Bills",
          `  Invoices available: ${invoices.length} | Bills available: ${bills.length}`,
          `  Found ${matchCandidates.filter(c => c.matchType === "invoice").length} credit matches (${p1ExactCredits} exact, ${p1AdjCredits} GST-adjusted)`,
          `  Found ${matchCandidates.filter(c => c.matchType === "bill").length} debit matches (${p1ExactDebits} exact, ${p1AdjDebits} TDS-adjusted)`,
          `  Would execute: ${matchCandidates.length} match(es)`,
        ]

        if (matchCandidates.length > 0) {
          lines.push("")
          lines.push("  | Date | Amount | Payee | Party | Type | Ref | Note |")
          lines.push("  |------|--------|-------|-------|------|-----|------|")
          for (const c of matchCandidates.slice(0, 20)) {
            lines.push(
              `  | ${c.txn.date} | INR ${c.txnAmount.toLocaleString("en-IN")} | ` +
              `${(c.txn.payee || "?").slice(0, 20)} | ${c.matchParty.slice(0, 20)} | ` +
              `${c.matchType} | ${c.matchRef} | ${c.matchNote} |`
            )
          }
          if (matchCandidates.length > 20) {
            lines.push(`  ...and ${matchCandidates.length - 20} more matches`)
          }
        }

        lines.push("")
        lines.push("---")
        lines.push("")
        lines.push("### Phase 2 — AI Auto-Categorize")
        lines.push(`  Confidence threshold: ${minConf}`)
        lines.push(`  Would categorize: ${p2ToExecute.length} transactions`)

        if (catBreakdown.size > 0) {
          lines.push("")
          lines.push("  Category breakdown:")
          const sorted = [...catBreakdown.entries()].sort((a, b) => b[1] - a[1])
          for (const [cat, count] of sorted) {
            lines.push(`    ${cat}: ${count}×`)
          }
        }

        if (p2ToReview.length > 0) {
          const byReason = new Map<string, number>()
          for (const c of p2ToReview) {
            const r = c.skipReason ?? "unknown"
            byReason.set(r, (byReason.get(r) ?? 0) + 1)
          }
          lines.push("")
          lines.push(`  Skipped (${p2ToReview.length} transactions):`)
          for (const [reason, count] of byReason) {
            lines.push(`    ${count}× — ${reason}`)
          }
        }

        lines.push("")
        lines.push("---")
        lines.push("")
        lines.push("### Phase 3 — Remaining After Auto-Reconciliation")
        lines.push(`  Still needs CA review: **${remaining > 0 ? remaining : 0}** transaction(s)`)
        if (remaining > 0) {
          lines.push("  Run export_uncategorized_to_csv to review these in Excel.")
        }
        lines.push("")
        lines.push("---")
        lines.push("")
        lines.push("## Summary")
        lines.push(`  Phase 1 (Match):           ${matchCandidates.length} would be cleared`)
        lines.push(`  Phase 2 (AI Categorize):   ${p2ToExecute.length} would be cleared`)
        lines.push(`  Total auto-cleared:         ${totalAutoCleared}`)
        lines.push(`  Remaining for CA:           ${remaining > 0 ? remaining : 0}`)
        lines.push("")
        lines.push("Set dry_run: false to execute.")
        return lines.join("\n")
      }

      // ─────────────────────────────────────────────────────────────────────────
      // EXECUTE
      // ─────────────────────────────────────────────────────────────────────────

      auditStart("reconcile_account", args.organization_id, "WRITE", "bank_reconciliation_pipeline", {
        account_id: args.account_id,
        phase1_candidates: matchCandidates.length,
        phase2_candidates: p2ToExecute.length,
      })

      // ── Phase 1: Execute matches ──────────────────────────────────────────────
      let p1Success = 0
      let p1Failed = 0
      const p1FailDetails: string[] = []

      for (let i = 0; i < matchCandidates.length; i++) {
        const limit = checkApiLimit("Phase 1 match")
        if (limit) return limit

        const c = matchCandidates[i]
        if (i > 0) await sleep(700)
        apiCallCount++

        if (!isSafeId(c.txn.transaction_id) || !isSafeId(c.matchId)) {
          p1Failed++
          p1FailDetails.push(`${c.txn.transaction_id}: invalid ID format`)
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
          auditSuccess("reconcile_account", args.organization_id, "WRITE", "bank_transaction", c.txn.transaction_id)
          p1Success++
        } else {
          const errMsg = res.errorMessage ?? "Unknown error"
          auditFail("reconcile_account", args.organization_id, "WRITE", "bank_transaction", errMsg)
          p1Failed++
          p1FailDetails.push(`${c.txn.date} ${c.txn.payee ?? "?"}: ${errMsg}`)
        }
      }

      // ── Phase 2: Execute categorizations ─────────────────────────────────────
      let p2Success = 0
      let p2Failed = 0
      const p2FailDetails: string[] = []

      for (let i = 0; i < p2ToExecute.length; i++) {
        const limit = checkApiLimit("Phase 2 categorize")
        if (limit) return limit

        const { txn, suggestion, accountId } = p2ToExecute[i]
        if (i > 0) await sleep(700)
        apiCallCount++

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
          auditSuccess("reconcile_account", args.organization_id, "WRITE", "bank_transaction", txn.transaction_id)
          p2Success++
        } else {
          const errMsg = res.errorMessage ?? "Unknown error"
          // Skip "already categorized" — Phase 1 may have just matched it
          if (!errMsg.toLowerCase().includes("already")) {
            auditFail("reconcile_account", args.organization_id, "WRITE", "bank_transaction", errMsg)
            p2Failed++
            p2FailDetails.push(`${txn.date} ${txn.payee ?? "?"}: ${errMsg}`)
          }
        }
      }

      // ── Phase 3: Count remaining ──────────────────────────────────────────────
      apiCallCount++
      const remaining = await fetchUncategorized(args.account_id, args.organization_id, 1000, args.date_start, args.date_end)
      const remainingCount = remaining.txns.length

      // ── Build report ──────────────────────────────────────────────────────────
      const p1Icon = p1Failed === 0 ? "✅" : p1Failed < p1Success ? "⚠️" : "❌"
      const p2Icon = p2Failed === 0 ? "✅" : p2Failed < p2Success ? "⚠️" : "❌"

      const lines: string[] = [
        `## Reconciliation Complete — Account \`${args.account_id}\``,
        `Date: ${new Date().toISOString().slice(0, 10)}`,
        "",
        `### ${p1Icon} Phase 1 — Match Results`,
        `  Matched: ${p1Success} | Failed: ${p1Failed}`,
        `  (Credits→Invoices: ${matchCandidates.filter(c => c.matchType === "invoice").length} attempted | Debits→Bills: ${matchCandidates.filter(c => c.matchType === "bill").length} attempted)`,
      ]

      if (p1FailDetails.length > 0) {
        lines.push("  Failed:")
        p1FailDetails.forEach(d => lines.push(`    ${d}`))
      }

      lines.push("")
      lines.push(`### ${p2Icon} Phase 2 — AI Categorize Results`)
      lines.push(`  Categorized: ${p2Success} | Failed: ${p2Failed}`)

      if (p2FailDetails.length > 0) {
        lines.push("  Failed:")
        p2FailDetails.forEach(d => lines.push(`    ${d}`))
      }

      lines.push("")
      lines.push("### Phase 3 — Remaining")
      if (remainingCount === 0) {
        lines.push("  Account fully reconciled.")
      } else {
        lines.push(`  Still needs CA review: **${remainingCount}** transaction(s)`)
        lines.push("  Run export_uncategorized_to_csv to review these in Excel.")
      }

      lines.push("")
      lines.push("---")
      lines.push("## Summary")
      lines.push(`  Phase 1 (Match):           ${p1Success} cleared`)
      lines.push(`  Phase 2 (AI Categorize):   ${p2Success} cleared`)
      lines.push(`  Total auto-cleared:         ${p1Success + p2Success}`)
      lines.push(`  Remaining for CA:           ${remainingCount}`)
      lines.push("")
      lines.push("Run verify_reconciliation to see the full account status dashboard.")

      return lines.join("\n")
    },
  })

  // ── TOOL 2: verify_reconciliation ──────────────────────────────────────────

  server.addTool({
    name: "verify_reconciliation",
    description: `Quick reconciliation status dashboard for a bank account.

Shows: total statement entries, categorized, uncategorized, progress %, and account balance.

Run this after reconcile_account to confirm results, or any time to check current status.

Output:
  - Progress bar (visual)
  - Transaction counts
  - Account balance from Zoho
  - Next step recommendation if uncategorized > 0`,

    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID from list_bank_accounts"),
    }),

    annotations: { title: "Verify Reconciliation Status", readOnlyHint: true, openWorldHint: true },

    execute: async (args) => {
      // ── Fetch all transactions and uncategorized ──────────────────────────────
      const [allTxns, uncatTxns] = await Promise.all([
        fetchAllStatement(args.account_id, args.organization_id, "all"),
        fetchAllStatement(args.account_id, args.organization_id, "uncategorized"),
      ])

      const total = allTxns.length
      const uncategorized = uncatTxns.length
      const categorized = Math.max(0, total - uncategorized)
      const pct = total > 0 ? Math.round((categorized / total) * 100) : 100

      // ── Progress bar ──────────────────────────────────────────────────────────
      const barLength = 20
      const filled = Math.round((pct / 100) * barLength)
      const empty   = barLength - filled
      const bar = "█".repeat(filled) + "░".repeat(empty)

      // ── Fetch bank account details ────────────────────────────────────────────
      let accountName = args.account_id
      let balance = "N/A"

      if (isSafeId(args.account_id)) {
        const accRes = await zohoGet<{ bankaccount: BankAccount }>(
          `/bankaccounts/${args.account_id}`,
          args.organization_id
        )
        if (accRes.ok && accRes.data?.bankaccount) {
          const acc = accRes.data.bankaccount
          accountName = acc.account_name ?? args.account_id
          if (acc.current_balance !== undefined && acc.current_balance !== null) {
            balance = `INR ${Number(acc.current_balance).toLocaleString("en-IN")}`
          }
        }
      }

      // ── Build dashboard ───────────────────────────────────────────────────────
      const lines: string[] = [
        `## Reconciliation Status — ${accountName} (\`${args.account_id}\`)`,
        `As of: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
        "",
        "| Metric | Value |",
        "|--------|-------|",
        `| Total statement entries | ${total} |`,
        `| Categorized | ${categorized} |`,
        `| Uncategorized | ${uncategorized} |`,
        `| Progress | [${bar}] ${pct}% |`,
        `| Account Balance | ${balance} |`,
        "",
      ]

      if (uncategorized === 0) {
        lines.push("Account fully reconciled. No pending transactions.")
      } else {
        lines.push(`${uncategorized} transaction(s) still need reconciliation.`)
        lines.push(`Next: run reconcile_account(account_id: "${args.account_id}") to auto-clear them.`)
      }

      return lines.join("\n")
    },
  })
}
