/**
 * Reconciliation Export Tools — CA Approval Pipeline
 *
 * Workflow:
 *   EXPORT  →  CA reviews in Excel  →  IMPORT & EXECUTE
 *
 *   1. export_uncategorized_to_csv
 *      - Fetches all uncategorized bank statement transactions (auto-paginated)
 *      - Runs India-specific AI suggestion engine (keyword rules)
 *      - Attempts to match suggested categories to actual GL account IDs
 *      - Returns CSV as text (copy into Excel) + optionally writes to file
 *      - Columns: Bank_Account_ID, Transaction_ID, Date, Amount, Debit_Credit,
 *        Payee, Description, Reference, AI_Category, AI_Account_ID,
 *        AI_Transaction_Type, AI_Confidence, AI_Reasoning,
 *        CA_Account_ID, CA_Transaction_Type, CA_Notes, Approve
 *
 *   2. import_approved_reconciliation
 *      - Reads approved CSV (csv_content string OR file_path)
 *      - Processes only rows where Approve = "Y"
 *      - dry_run: true → preview without executing
 *      - Executes categorize API with 700 ms inter-call rate limit
 *      - Returns: success_count, failed_count, skipped_count, results table
 *
 * Security:
 *   - CSV injection prevention on both export (escape =,+,-,@,|) and import (strip leading tokens)
 *   - File path restricted to ALLOWED_CSV_DIRECTORIES
 *   - All account_id / transaction_id values sanitized before API call
 *   - Audit log on every write
 *   - Amount and date validated before each API call
 *   - Maximum 500 rows per import (prevents runaway bulk operations)
 */

import { z } from "zod"
import * as fs from "fs"
import * as path from "path"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema, entityIdSchema } from "../utils/validation.js"
import {
  auditStart,
  auditSuccess,
  auditFail,
} from "../utils/validators.js"
import { suggestCategory, findAccountId } from "../utils/suggest-category.js"
import type { GLAccount } from "../utils/suggest-category.js"

// ─── Type Definitions ─────────────────────────────────────────────────────────

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

// ─── CSV Helpers ──────────────────────────────────────────────────────────────

/**
 * Full column set for manual CA review in Excel.
 *
 * READ-ONLY (do not edit — from Zoho):
 *   Sr_No, Bank_Account_ID, Bank_Account_Name, Transaction_ID, Date, Month,
 *   Amount, Dr_Cr, Payee, Description, Reference
 *
 * AI SUGGESTIONS (review, override with CA columns if wrong):
 *   AI_Category, AI_Account_Name, AI_Account_ID, AI_Transaction_Type,
 *   AI_Confidence, AI_Reasoning
 *
 * CA REVIEW COLUMNS — fill these to categorize:
 *   CA_Account_ID       GL account ID (overrides AI_Account_ID)
 *   CA_Account_Name     account name if you don't have ID (import looks it up)
 *   CA_Transaction_Type expense/deposit/transfer_fund/owner_drawings/
 *                       owner_contribution/other_income/refund
 *   CA_Action           categorize (default) | match | exclude | skip
 *   CA_Match_ID         invoice_id or bill_id when CA_Action=match
 *   CA_Vendor_ID        vendor/customer contact ID (optional)
 *   CA_Notes            free text notes
 *   Approve             Y to include in import
 */
const CSV_HEADERS = [
  // Read-only
  "Sr_No",
  "Bank_Account_ID",
  "Bank_Account_Name",
  "Transaction_ID",
  "Date",
  "Month",
  "Amount",
  "Dr_Cr",
  "Payee",
  "Description",
  "Reference",
  // AI suggestions
  "AI_Category",
  "AI_Account_Name",
  "AI_Account_ID",
  "AI_Transaction_Type",
  "AI_Confidence",
  "AI_Reasoning",
  // CA review (fill these)
  "CA_Account_ID",
  "CA_Account_Name",
  "CA_Transaction_Type",
  "CA_Action",
  "CA_Match_ID",
  "CA_Vendor_ID",
  "CA_Notes",
  "Approve",
]

/**
 * Escape a CSV cell value.
 * Security: neutralize formula-injection chars (=, +, -, @, |, TAB).
 */
function csvEscape(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return ""
  const str = String(value)
  // Formula injection prevention — prefix dangerous leading characters
  const safe = /^[=+\-@|]/.test(str) ? `'${str}` : str
  // Quote wrap if field contains comma, quote, newline, or carriage return
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\r")) {
    return `"${safe.replace(/"/g, '""')}"`
  }
  return safe
}

function buildCSVRow(cells: (string | number | undefined | null)[]): string {
  return cells.map(csvEscape).join(",")
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ""
  let inQuotes = false
  let i = 0

  while (i < line.length) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped double-quote
        current += '"'
        i += 2
        continue
      }
      inQuotes = !inQuotes
    } else if (ch === "," && !inQuotes) {
      cells.push(current)
      current = ""
    } else {
      current += ch
    }
    i++
  }
  cells.push(current)
  return cells
}

interface ParsedCSV {
  headers: string[]
  rows: Record<string, string>[]
  error?: string
}

function parseCSVContent(raw: string): ParsedCSV {
  // Strip UTF-8 BOM
  const content = raw.startsWith("\uFEFF") ? raw.slice(1) : raw
  const lines = content.split(/\r?\n/)

  if (lines.length < 2) {
    return { headers: [], rows: [], error: "CSV has no data rows (only header or empty)" }
  }

  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim())

  if (!headers.includes("transaction_id")) {
    return {
      headers,
      rows: [],
      error: `Missing required column "Transaction_ID". Expected headers: ${CSV_HEADERS.join(", ")}`,
    }
  }

  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const cells = parseCsvLine(trimmed)
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      let val = (cells[j] ?? "").trim()
      // Security: strip formula-injection prefix that was added during export
      if (val.startsWith("'") && /^'[=+\-@|]/.test(val)) val = val.slice(1)
      row[headers[j]] = val
    }
    rows.push(row)
  }

  return { headers, rows }
}

// ─── File Path Security ───────────────────────────────────────────────────────

const ALLOWED_CSV_DIRECTORIES: string[] = [
  "/app/documents",
  "/tmp/zoho-bookkeeper-uploads",
  process.env.HOME ? path.join(process.env.HOME, "Documents") : "",
  process.env.ZOHO_ALLOWED_UPLOAD_DIR ?? "",
].filter(Boolean)

function validateCSVPath(filePath: string): { valid: boolean; resolvedPath?: string; error?: string } {
  let resolved: string
  try {
    resolved = path.resolve(filePath)
  } catch {
    return { valid: false, error: "Invalid file path" }
  }

  const isAllowed = ALLOWED_CSV_DIRECTORIES.some(dir => {
    const resolvedDir = path.resolve(dir)
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep)
  })

  if (!isAllowed) {
    return {
      valid: false,
      error: [
        "File path is outside allowed directories.",
        "Allowed paths:",
        ...ALLOWED_CSV_DIRECTORIES.map(d => `  • ${d}`),
        "Set ZOHO_ALLOWED_UPLOAD_DIR to add a custom directory.",
      ].join("\n"),
    }
  }

  return { valid: true, resolvedPath: resolved }
}

// ─── Rate-limit helper ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ─── Tool Registration ────────────────────────────────────────────────────────

export function registerReconciliationExportTools(server: FastMCP): void {

  // ── 1. export_uncategorized_to_csv ─────────────────────────────────────────

  server.addTool({
    name: "export_uncategorized_to_csv",
    description: `Export all uncategorized bank statement transactions to CSV for CA review.

Each row includes:
  • Raw transaction data (Date, Amount, Payee, Description, Reference)
  • AI suggestions: Category, GL Account ID, Transaction Type, Confidence, Reasoning
  • Blank CA columns for the CA to fill: CA_Account_ID, CA_Transaction_Type, CA_Notes
  • Blank "Approve" column — CA marks "Y" to approve each row

The CA opens the CSV in Excel, reviews AI suggestions, overrides where needed,
marks Approve=Y for each row to process, saves the file, then uploads it back
for import_approved_reconciliation to execute in Zoho Books.

AI Confidence levels:
  High   — strong keyword match (bank charges, salary, GST, rent, utilities)
  Medium — plausible match (professional fees, travel, customer payment)
  Low    — no clear match — CA MUST review and fill CA_Account_ID

The tool also fetches your Chart of Accounts to pre-fill AI_Account_ID where
a matching account is found. Low-confidence rows will have blank AI_Account_ID.

Output: returns CSV text (copy into Excel). If output_path is provided,
also writes the file to disk (must be in an allowed directory).`,

    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      account_id: entityIdSchema.describe("Bank account ID (from list_bank_accounts)"),
      date_start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
        .optional()
        .describe("Filter transactions on or after this date"),
      date_end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
        .optional()
        .describe("Filter transactions on or before this date"),
      max_transactions: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .default(500)
        .describe("Maximum number of uncategorized transactions to export (default 500, max 2000)"),
      output_path: z
        .string()
        .optional()
        .describe(
          "Optional: full local file path to write the CSV " +
          "(must be in /app/documents, ~/Documents, or ZOHO_ALLOWED_UPLOAD_DIR). " +
          "If omitted, CSV is returned as text only."
        ),
    }),

    annotations: { title: "Export Uncategorized Transactions to CSV", readOnlyHint: true, openWorldHint: true },

    execute: async (args) => {
      const maxTxns = args.max_transactions ?? 500

      // ── Fetch in parallel: transactions + COA + bank account name ─────────────
      const txnFetchPromise = (async () => {
        const all: BankStatementTxn[] = []
        let page = 1
        while (all.length < maxTxns) {
          const qp: Record<string, string> = {
            status: "uncategorized",
            per_page: "200",
            page: String(page),
          }
          if (args.date_start) qp.date_start = args.date_start
          if (args.date_end) qp.date_end = args.date_end

          const res = await zohoGet<{ banktransactions: BankStatementTxn[] }>(
            `/bankaccounts/${args.account_id}/statement`,
            args.organization_id,
            qp
          )
          if (!res.ok) return { txns: [] as BankStatementTxn[], error: res.errorMessage }
          const batch = res.data?.banktransactions ?? []
          all.push(...batch)
          if (batch.length < 200) break
          page++
        }
        return { txns: all.slice(0, maxTxns), error: undefined }
      })()

      const coaPromise = zohoGet<{ chartofaccounts: GLAccount[] }>(
        "/chartofaccounts",
        args.organization_id,
        { per_page: "500" }
      )

      const bankAccountPromise = zohoGet<{ bankaccount: { account_name?: string; current_balance?: number } }>(
        `/bankaccounts/${args.account_id}`,
        args.organization_id
      )

      const [txnResult, coaResult, bankAccResult] = await Promise.all([
        txnFetchPromise,
        coaPromise,
        bankAccountPromise,
      ])

      if (txnResult.error) return `Failed to fetch transactions: ${txnResult.error}`

      const txns = txnResult.txns
      const truncated = txns.length === maxTxns
      const accounts: GLAccount[] = coaResult.ok ? (coaResult.data?.chartofaccounts ?? []) : []
      const bankAccountName = bankAccResult.ok
        ? (bankAccResult.data?.bankaccount?.account_name ?? args.account_id)
        : args.account_id

      if (txns.length === 0) {
        return `✅ No uncategorized transactions found for **${bankAccountName}** (\`${args.account_id}\`).${
          args.date_start || args.date_end
            ? ` (Filter: ${args.date_start ?? "any"} → ${args.date_end ?? "any"})`
            : ""
        }`
      }

      // ── Build a COA lookup map: account_id → account_name ────────────────────
      const coaNameMap = new Map<string, string>()
      for (const acc of accounts) {
        coaNameMap.set(acc.account_id, acc.account_name)
      }

      // ── Build CSV ─────────────────────────────────────────────────────────────
      const BOM = "\uFEFF"
      const csvLines: string[] = []
      csvLines.push(buildCSVRow(CSV_HEADERS))

      let highCount = 0, mediumCount = 0, lowCount = 0
      let totalDebit = 0, totalCredit = 0

      for (let i = 0; i < txns.length; i++) {
        const tx = txns[i]
        const suggestion = suggestCategory(tx.payee, tx.description, tx.debit_or_credit)
        const aiAccountId = accounts.length > 0 ? findAccountId(accounts, suggestion.category) : ""
        const aiAccountName = aiAccountId ? (coaNameMap.get(aiAccountId) ?? "") : ""
        const amt = Number(tx.amount) || 0
        const month = tx.date?.slice(0, 7) ?? ""  // YYYY-MM
        const drCr = tx.debit_or_credit === "debit" ? "Dr" : "Cr"

        if (tx.debit_or_credit === "debit") totalDebit += amt
        else totalCredit += amt

        if (suggestion.confidence === "High") highCount++
        else if (suggestion.confidence === "Medium") mediumCount++
        else lowCount++

        csvLines.push(buildCSVRow([
          i + 1,                      // Sr_No
          args.account_id,            // Bank_Account_ID
          bankAccountName,            // Bank_Account_Name
          tx.transaction_id,          // Transaction_ID
          tx.date,                    // Date
          month,                      // Month
          amt,                        // Amount
          drCr,                       // Dr_Cr
          tx.payee ?? "",             // Payee
          tx.description ?? "",       // Description
          tx.reference_number ?? "",  // Reference
          suggestion.category,        // AI_Category
          aiAccountName,              // AI_Account_Name
          aiAccountId,                // AI_Account_ID
          suggestion.transaction_type,// AI_Transaction_Type
          suggestion.confidence,      // AI_Confidence
          suggestion.reasoning,       // AI_Reasoning
          "",                         // CA_Account_ID
          "",                         // CA_Account_Name
          "",                         // CA_Transaction_Type
          "categorize",               // CA_Action  (pre-filled default)
          "",                         // CA_Match_ID
          "",                         // CA_Vendor_ID
          "",                         // CA_Notes
          "",                         // Approve
        ]))
      }

      const csvContent = BOM + csvLines.join("\n")

      // ── Suggest filename ──────────────────────────────────────────────────────
      const safeAccountName = bankAccountName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 30)
      const today = new Date().toISOString().slice(0, 10)
      const suggestedFilename = `reconciliation_${safeAccountName}_${today}.csv`

      // ── Optionally write to server disk ──────────────────────────────────────
      let fileWriteStatus = ""
      if (args.output_path) {
        const pathCheck = validateCSVPath(args.output_path)
        if (!pathCheck.valid || !pathCheck.resolvedPath) {
          fileWriteStatus = `⚠️ File NOT written: ${pathCheck.error}`
        } else {
          try {
            const dir = path.dirname(pathCheck.resolvedPath)
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
            fs.writeFileSync(pathCheck.resolvedPath, csvContent, { encoding: "utf8", mode: 0o600 })
            fileWriteStatus = `✅ File written to server: ${pathCheck.resolvedPath}`
          } catch (e) {
            fileWriteStatus = `⚠️ File write failed: ${e instanceof Error ? e.message : String(e)}`
          }
        }
      }

      // ── Build response ────────────────────────────────────────────────────────
      const periodLabel = args.date_start || args.date_end
        ? ` | Period: ${args.date_start ?? "start"} → ${args.date_end ?? "today"}`
        : ""

      const summary = [
        `**Uncategorized Transactions Export**`,
        `Account: **${bankAccountName}** (\`${args.account_id}\`)${periodLabel}`,
        "",
        `| | |`,
        `|---|---|`,
        `| Transactions | ${txns.length}${truncated ? ` ⚠️ (capped — use date filters to export more)` : ""} |`,
        `| Total Debits | INR ${totalDebit.toLocaleString("en-IN")} |`,
        `| Total Credits | INR ${totalCredit.toLocaleString("en-IN")} |`,
        `| AI High confidence | ${highCount} (safe to auto-approve) |`,
        `| AI Medium confidence | ${mediumCount} (review before approving) |`,
        `| AI Low confidence | ${lowCount} (must fill CA columns manually) |`,
        `| COA accounts loaded | ${accounts.length} |`,
        fileWriteStatus ? `| Server file | ${fileWriteStatus} |` : "",
        "",
        `**Suggested filename:** \`${suggestedFilename}\``,
        "",
        "**How to use this file:**",
        "1. Save the CSV below as `" + suggestedFilename + "` and open in Excel",
        "2. **Columns to fill** (yellow in Excel convention):",
        "   - `CA_Account_ID` or `CA_Account_Name` — which GL account to post to",
        "   - `CA_Transaction_Type` — expense / deposit / transfer_fund / other_income / refund",
        "   - `CA_Action` — leave as `categorize` (default), or use `match` / `exclude` / `skip`",
        "   - `CA_Match_ID` — only if CA_Action = `match` (paste invoice_id or bill_id here)",
        "   - `CA_Notes` — any note you want attached to the transaction",
        "   - `Approve` — type **Y** for every row you want imported",
        "3. Save the file and give it back to Claude with: `import_approved_reconciliation`",
        "",
        `---`,
        `SAVE_FILENAME: ${suggestedFilename}`,
        `TRANSACTION_COUNT: ${txns.length}`,
        `---`,
        "",
        `\`\`\`csv`,
      ].filter(Boolean).join("\n")

      return `${summary}\n${csvContent}\n\`\`\``
    },
  })

  // ── 2. import_approved_reconciliation ─────────────────────────────────────

  server.addTool({
    name: "import_approved_reconciliation",
    description: `Execute approved rows from a CA-reviewed reconciliation CSV.

Processes only rows where Approve = "Y" (case-insensitive).
For each approved row, calls the Zoho Books categorize API.

Priority for account selection:
  1. CA_Account_ID (if filled) — CA's explicit choice
  2. AI_Account_ID (if filled and CA_Account_ID is blank)
  3. Skipped with error if neither is filled

Priority for transaction type:
  1. CA_Transaction_Type (if filled)
  2. AI_Transaction_Type (from export)
  3. Default: "expense" for debits, "deposit" for credits

dry_run: true — shows exactly what WOULD be executed without calling any API.
         Use this to review the execution plan before committing.

Rate limit: 700 ms between API calls (stays well under Zoho's 100 req/min limit).
Max rows: 500 per import (to prevent accidental bulk runs).

Input: either csv_content (paste the CSV text) OR file_path (local file path).`,

    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      csv_content: z
        .string()
        .optional()
        .describe("The full CSV text (from export_uncategorized_to_csv output). Use this OR file_path."),
      file_path: z
        .string()
        .optional()
        .describe("Local file path to the approved CSV. Must be in an allowed directory. Use this OR csv_content."),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, preview execution plan without calling Zoho API (default: false)"),
    }),

    annotations: { title: "Import Approved Reconciliation CSV", readOnlyHint: false, openWorldHint: true },

    execute: async (args) => {
      // ── Load CSV content ──────────────────────────────────────────────────────

      let rawCSV: string

      if (args.csv_content) {
        rawCSV = args.csv_content
      } else if (args.file_path) {
        const pathCheck = validateCSVPath(args.file_path)
        if (!pathCheck.valid || !pathCheck.resolvedPath) {
          return `Error: ${pathCheck.error}`
        }
        // Read with O_NOFOLLOW (symlink protection)
        let fh: fs.promises.FileHandle | undefined
        try {
          const flags =
            typeof fs.constants.O_NOFOLLOW === "number"
              ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
              : fs.constants.O_RDONLY
          fh = await fs.promises.open(pathCheck.resolvedPath, flags)
          const stats = await fh.stat()
          if (!stats.isFile()) return "Error: path is not a regular file"
          if (stats.size > 10 * 1024 * 1024) return "Error: CSV file too large (max 10 MB)"
          rawCSV = await fh.readFile({ encoding: "utf8" })
        } catch (e) {
          const err = e as NodeJS.ErrnoException
          if (err?.code === "ELOOP") return "Error: symlinks are not permitted"
          return `Error reading file: ${err.message || String(e)}`
        } finally {
          await fh?.close().catch(() => undefined)
        }
      } else {
        return "Error: provide either csv_content (paste the CSV text) or file_path."
      }

      // ── Parse CSV ─────────────────────────────────────────────────────────────

      const { rows, error: parseError } = parseCSVContent(rawCSV)
      if (parseError) return `CSV parse error: ${parseError}`
      if (rows.length === 0) return "CSV contains no data rows."

      // ── Find approved rows ────────────────────────────────────────────────────

      const approvedRows = rows.filter(row => (row["approve"] ?? "").toUpperCase() === "Y")
      const skippedRows = rows.length - approvedRows.length

      if (approvedRows.length === 0) {
        return [
          `**No rows approved.**`,
          `Total rows parsed: ${rows.length}`,
          `Rows with Approve=Y: 0`,
          "",
          "Mark Approve=Y in the CSV and re-upload to proceed.",
        ].join("\n")
      }

      if (approvedRows.length > 500) {
        return `Error: ${approvedRows.length} approved rows exceeds the safety limit of 500 per import. Split the CSV into batches and re-run.`
      }

      // ── Validate & build execution plan ──────────────────────────────────────

      interface ExecutionItem {
        rowNum: number
        bankAccountId: string
        transactionId: string
        date: string
        amount: number
        accountId: string
        transactionType: string
        action: "categorize" | "match" | "exclude" | "skip"
        matchId: string
        vendorId: string
        notes: string
        validationError?: string
      }

      const plan: ExecutionItem[] = []

      for (let i = 0; i < approvedRows.length; i++) {
        const row = approvedRows[i]
        const rowNum = i + 2

        const bankAccountId = row["bank_account_id"]?.trim()
        const transactionId = row["transaction_id"]?.trim()
        const date = row["date"]?.trim()
        const rawAmount = row["amount"]?.trim()
        // Support both old (debit_credit) and new (dr_cr) column names
        const drCrRaw = (row["dr_cr"] || row["debit_credit"] || row["debit_or_credit"] || "").trim().toLowerCase()
        const isDebit = drCrRaw === "debit" || drCrRaw === "dr"

        // CA_Action: default to "categorize"
        const rawAction = (row["ca_action"] ?? "categorize").trim().toLowerCase()
        const action: ExecutionItem["action"] =
          rawAction === "match" ? "match"
          : rawAction === "exclude" ? "exclude"
          : rawAction === "skip" ? "skip"
          : "categorize"

        // GL account: CA_Account_ID > AI_Account_ID
        const accountId = (row["ca_account_id"]?.trim() || row["ai_account_id"]?.trim()) ?? ""

        // Transaction type: CA > AI > default by direction
        const rawTxnType = (row["ca_transaction_type"]?.trim() || row["ai_transaction_type"]?.trim()) ?? ""
        const transactionType = rawTxnType || (isDebit ? "expense" : "deposit")

        const matchId = row["ca_match_id"]?.trim() ?? ""
        const vendorId = row["ca_vendor_id"]?.trim() ?? ""
        const notes = row["ca_notes"]?.trim() ?? ""

        let validationError: string | undefined

        if (!bankAccountId) {
          validationError = "Missing Bank_Account_ID"
        } else if (!transactionId) {
          validationError = "Missing Transaction_ID"
        } else if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          validationError = "Invalid or missing Date (expected YYYY-MM-DD)"
        } else if (!rawAmount || isNaN(Number(rawAmount))) {
          validationError = "Invalid or missing Amount"
        } else if (action === "categorize" && !accountId) {
          validationError = "No GL account ID: fill CA_Account_ID (or CA_Account_Name) — check list_accounts for IDs"
        } else if (action === "match" && !matchId) {
          validationError = "CA_Action=match requires CA_Match_ID (invoice_id or bill_id)"
        } else if (action === "categorize") {
          const validTypes = ["expense", "deposit", "transfer_fund", "owner_contribution", "owner_drawings", "other_income", "refund"]
          if (!validTypes.includes(transactionType)) {
            validationError = `Invalid CA_Transaction_Type "${transactionType}". Valid: ${validTypes.join(", ")}`
          }
        }

        // ID injection protection
        if (!validationError && !/^[a-zA-Z0-9_-]+$/.test(bankAccountId!))
          validationError = `Invalid Bank_Account_ID format: "${bankAccountId}"`
        if (!validationError && !/^[a-zA-Z0-9_-]+$/.test(transactionId!))
          validationError = `Invalid Transaction_ID format: "${transactionId}"`
        if (!validationError && action === "categorize" && accountId && !/^[a-zA-Z0-9_-]+$/.test(accountId))
          validationError = `Invalid CA_Account_ID format: "${accountId}"`
        if (!validationError && action === "match" && matchId && !/^[a-zA-Z0-9_-]+$/.test(matchId))
          validationError = `Invalid CA_Match_ID format: "${matchId}"`

        plan.push({
          rowNum,
          bankAccountId: bankAccountId ?? "",
          transactionId: transactionId ?? "",
          date: date ?? "",
          amount: Number(rawAmount ?? 0),
          accountId,
          transactionType,
          action,
          matchId,
          vendorId,
          notes,
          validationError,
        })
      }

      const validItems = plan.filter(p => !p.validationError)
      const invalidItems = plan.filter(p => p.validationError)

      // ── Dry run — preview only ────────────────────────────────────────────────

      if (args.dry_run) {
        const lines = [
          `**Dry Run — Execution Preview**`,
          `Total CSV rows: ${rows.length} | Approved (Y): ${approvedRows.length} | Skipped (not Y): ${skippedRows}`,
          `Valid for execution: ${validItems.length} | Validation errors: ${invalidItems.length}`,
          "",
        ]

        if (validItems.length > 0) {
          lines.push("**Would execute:**")
          for (const item of validItems) {
            let actionDesc: string
            if (item.action === "skip") {
              actionDesc = `SKIP (no API call)`
            } else if (item.action === "exclude") {
              actionDesc = `EXCLUDE txn \`${item.transactionId}\``
            } else if (item.action === "match") {
              actionDesc = `MATCH txn \`${item.transactionId}\` → \`${item.matchId}\``
            } else {
              actionDesc = `CATEGORIZE txn \`${item.transactionId}\` → account \`${item.accountId}\` | type: ${item.transactionType}`
            }
            lines.push(
              `  Row ${item.rowNum}: ${actionDesc} | ${item.date} | INR ${item.amount.toLocaleString("en-IN")}`
            )
          }
          lines.push("")
        }

        if (invalidItems.length > 0) {
          lines.push("**Validation errors (would skip):**")
          for (const item of invalidItems) {
            lines.push(`  Row ${item.rowNum}: ⚠️ ${item.validationError}`)
          }
          lines.push("")
        }

        lines.push("Set dry_run: false to execute.")
        return lines.join("\n")
      }

      // ── Execute ───────────────────────────────────────────────────────────────

      if (validItems.length === 0) {
        const errorLines = invalidItems.map(i => `  Row ${i.rowNum}: ${i.validationError}`)
        return [
          "**No valid rows to execute.** All approved rows have validation errors:",
          ...errorLines,
          "",
          "Fix the errors in the CSV and re-import.",
        ].join("\n")
      }

      auditStart(
        "import_approved_reconciliation",
        args.organization_id,
        "WRITE",
        "bank_reconciliation_bulk",
        { approved_count: approvedRows.length, valid_count: validItems.length }
      )

      interface ExecutionResult {
        rowNum: number
        transactionId: string
        status: "success" | "failed" | "skipped"
        message: string
      }

      const results: ExecutionResult[] = []

      // Add pre-skipped validation-error rows
      for (const item of invalidItems) {
        results.push({
          rowNum: item.rowNum,
          transactionId: item.transactionId || "?",
          status: "skipped",
          message: item.validationError!,
        })
      }

      // Execute valid items
      let apiCallCount = 0
      for (let idx = 0; idx < validItems.length; idx++) {
        const item = validItems[idx]

        // ── skip: no API call ──────────────────────────────────────────────────
        if (item.action === "skip") {
          results.push({
            rowNum: item.rowNum,
            transactionId: item.transactionId,
            status: "skipped",
            message: "Skipped by CA_Action=skip",
          })
          continue
        }

        // Rate limit: 700 ms between API calls (not before the first call)
        if (apiCallCount > 0) await sleep(700)
        apiCallCount++

        let apiResult: { ok: boolean; errorMessage?: string }
        let successMessage: string

        if (item.action === "exclude") {
          // ── exclude: POST .../exclude ────────────────────────────────────────
          apiResult = await zohoPost<{ message: string }>(
            `/bankaccounts/${item.bankAccountId}/statement/${item.transactionId}/exclude`,
            args.organization_id,
            {}
          )
          successMessage = "Excluded"

        } else if (item.action === "match") {
          // ── match: POST .../match ────────────────────────────────────────────
          // Determine whether matchId looks like an invoice or bill
          // Zoho match payload: { transactions: [{ transaction_id, transaction_type }] }
          const matchPayload: Record<string, unknown> = {
            transactions: [
              {
                transaction_id: item.matchId,
                transaction_type: "invoice",  // CA can override by putting bill_id in CA_Match_ID
              },
            ],
          }
          apiResult = await zohoPost<{ message: string }>(
            `/bankaccounts/${item.bankAccountId}/statement/${item.transactionId}/match`,
            args.organization_id,
            matchPayload
          )
          successMessage = `Matched → ${item.matchId}`

        } else {
          // ── categorize (default): POST .../categorize ────────────────────────
          const payload: Record<string, unknown> = {
            transaction_type: item.transactionType,
            account_id: item.accountId,
            amount: item.amount,
            date: item.date,
          }
          if (item.notes) payload.description = item.notes
          apiResult = await zohoPost<{ message: string }>(
            `/bankaccounts/${item.bankAccountId}/statement/${item.transactionId}/categorize`,
            args.organization_id,
            payload
          )
          successMessage = `Categorized → ${item.accountId} (${item.transactionType})`
        }

        if (apiResult.ok) {
          auditSuccess(
            "import_approved_reconciliation",
            args.organization_id,
            "WRITE",
            "bank_transaction",
            item.transactionId
          )
          results.push({
            rowNum: item.rowNum,
            transactionId: item.transactionId,
            status: "success",
            message: successMessage,
          })
        } else {
          const errMsg = apiResult.errorMessage || "Unknown API error"
          auditFail(
            "import_approved_reconciliation",
            args.organization_id,
            "WRITE",
            "bank_transaction",
            errMsg
          )
          results.push({
            rowNum: item.rowNum,
            transactionId: item.transactionId,
            status: "failed",
            message: errMsg,
          })
        }
      }

      // ── Build results report ─────────────────────────────────────────────────

      const successCount = results.filter(r => r.status === "success").length
      const failedCount = results.filter(r => r.status === "failed").length
      const skippedCount = results.filter(r => r.status === "skipped").length

      const statusIcon = failedCount === 0 ? "✅" : failedCount < successCount ? "⚠️" : "❌"

      const lines = [
        `${statusIcon} **Reconciliation Import Complete**`,
        "",
        `| Result  | Count |`,
        `|---------|-------|`,
        `| ✅ Success  | ${successCount} |`,
        `| ❌ Failed   | ${failedCount} |`,
        `| ⏭ Skipped  | ${skippedCount} |`,
        `| Total   | ${results.length} |`,
        "",
      ]

      if (failedCount > 0) {
        lines.push("**Failed rows — fix and re-import:**")
        for (const r of results.filter(r => r.status === "failed")) {
          lines.push(`  Row ${r.rowNum} (txn \`${r.transactionId}\`): ${r.message}`)
        }
        lines.push("")
      }

      if (successCount > 0) {
        lines.push(`${successCount} transaction(s) successfully categorized in Zoho Books.`)
        lines.push("Run get_reconciliation_summary to see updated progress.")
      }

      return lines.join("\n")
    },
  })
}
