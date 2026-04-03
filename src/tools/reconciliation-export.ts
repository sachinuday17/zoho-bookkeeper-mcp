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

interface GLAccount {
  account_id: string
  account_name: string
  account_type?: string
}

interface SuggestionResult {
  category: string
  transaction_type: string
  confidence: "High" | "Medium" | "Low"
  reasoning: string
}

// ─── India-Specific Suggestion Engine ────────────────────────────────────────
//
// Rules are applied in order — first match wins.
// Debit = money out (expense / transfer).
// Credit = money in (income / deposit / refund).

interface SuggestionRule {
  pattern: RegExp
  category: string        // human-readable GL account name (for fuzzy COA lookup)
  transaction_type: string // Zoho categorize API transaction_type value
  confidence: "High" | "Medium" | "Low"
  reasoning: string
}

const DEBIT_RULES: SuggestionRule[] = [
  // ── Self-transfers (check before any expense rule to avoid misclassification)
  {
    pattern: /self\s*transfer|own\s*transfer|inter.?account|transfer\s*to\s*(self|own|savings|current)|between\s*accounts/i,
    category: "Bank Transfer",
    transaction_type: "transfer_fund",
    confidence: "High",
    reasoning: "Matches inter-account / self-transfer keywords",
  },
  // ── Bank charges
  {
    pattern: /bank\s*(charge|fee|service|charges|commission|annual\s*fee|processing\s*fee|chgs)|neft\s*charges|rtgs\s*charges|imps\s*charges|sms\s*alert\s*charges/i,
    category: "Bank Charges",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches bank charge / fee keywords",
  },
  // ── GST / Tax payments
  {
    pattern: /gst\s*(payment|challan|paid|payable)|igst|cgst|sgst|tds\s*(payment|deposit|challan)|advance\s*tax|income\s*tax\s*(payment|challan)|tax\s*challan|nsdl|traces/i,
    category: "Tax Payments",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches GST / TDS / advance tax payment keywords",
  },
  // ── Salary / Payroll
  {
    pattern: /salary|payroll|wages|staff\s*payment|employee\s*payment|sal\b|pay\s*slip/i,
    category: "Salaries and Wages",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches salary / payroll / wages keywords",
  },
  // ── Rent
  {
    pattern: /rent\b|rental|lease\s*payment|office\s*rent|shop\s*rent|godown\s*rent/i,
    category: "Rent Expense",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches rent / lease keywords",
  },
  // ── Electricity / Power
  {
    pattern: /electricity|power\s*bill|bses|mseb|tneb|bescom|hescom|tsspdcl|apspdcl|wbsedcl|jvvnl|uppcl|dnhdd/i,
    category: "Electricity Expense",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches electricity / power board keywords",
  },
  // ── Water
  {
    pattern: /water\s*bill|water\s*supply|water\s*tax|bwssb|nmmc|mcgm\s*water/i,
    category: "Utilities",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches water supply / utility keywords",
  },
  // ── Telecom / Internet
  {
    pattern: /airtel|jio\s*(fiber|postpaid|prepaid)?|vodafone|idea|vi\b|bsnl|mtnl|internet\s*bill|broadband|telecom|mobile\s*bill|data\s*plan/i,
    category: "Telephone Expense",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches telecom / internet provider keywords",
  },
  // ── Loan / EMI
  {
    pattern: /\bemi\b|loan\s*(repayment|installment|emi)|term\s*loan|home\s*loan|car\s*loan|vehicle\s*loan|od\s*repayment/i,
    category: "Loan Repayments",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches EMI / loan repayment keywords",
  },
  // ── Insurance
  {
    pattern: /insurance|premium\s*(payment|due)|lic\b|hdfc\s*life|icici\s*pru|bajaj\s*allianz|star\s*health|new\s*india|national\s*insurance/i,
    category: "Insurance Expense",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches insurance premium keywords",
  },
  // ── Professional fees
  {
    pattern: /professional\s*fee|consultant|legal\s*fee|advocate|audit\s*fee|ca\s*fee|retainer|advisory\s*fee/i,
    category: "Professional Fees",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches professional / legal / audit fee keywords",
  },
  // ── Advertising / Marketing
  {
    pattern: /google\s*ads|facebook\s*ads|meta\s*ads|youtube\s*ads|instagram\s*ads|advertising|ad\s*spend|marketing|promotion/i,
    category: "Advertising Expense",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches advertising / digital marketing keywords",
  },
  // ── Travel
  {
    pattern: /travel|hotel|flight|air\s*ticket|irctc|air\s*india|indigo|vistara|spicejet|go\s*air|uber|ola\b|cab\s*fare|taxi|train\s*ticket|boarding|lodging/i,
    category: "Travel Expenses",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches travel / hotel / flight keywords",
  },
  // ── Subscription / Software
  {
    pattern: /subscription|zoho|tally|quickbooks|microsoft|google\s*workspace|aws|azure|hosting|domain|saas|software\s*(license|renewal)/i,
    category: "Software Subscriptions",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches software / SaaS subscription keywords",
  },
  // ── Office supplies / Printing
  {
    pattern: /stationery|office\s*supply|printing|cartridge|paper\s*ream|amazon|flipkart|meesho/i,
    category: "Office Supplies",
    transaction_type: "expense",
    confidence: "Low",
    reasoning: "Matches office supply / e-commerce keywords",
  },
  // ── Owner drawings
  {
    pattern: /drawings|proprietor\s*withdrawal|owner\s*withdrawal/i,
    category: "Owner Drawings",
    transaction_type: "owner_drawings",
    confidence: "High",
    reasoning: "Matches owner drawings / proprietor withdrawal keywords",
  },
]

const CREDIT_RULES: SuggestionRule[] = [
  // ── Bank interest
  {
    pattern: /interest\s*(credit|earned|income|on\s*savings|on\s*fd|on\s*deposit)|savings\s*account\s*interest|fd\s*interest/i,
    category: "Interest Income",
    transaction_type: "other_income",
    confidence: "High",
    reasoning: "Matches bank / FD interest income keywords",
  },
  // ── GST / Tax refund
  {
    pattern: /gst\s*refund|tax\s*refund|income\s*tax\s*refund|tds\s*refund/i,
    category: "Tax Refund",
    transaction_type: "other_income",
    confidence: "High",
    reasoning: "Matches GST / income-tax refund keywords",
  },
  // ── Cashback / Refund
  {
    pattern: /cashback|refund|reversal|credit\s*note|return\s*credit|clawback/i,
    category: "Other Income",
    transaction_type: "refund",
    confidence: "Medium",
    reasoning: "Matches cashback / refund / reversal keywords",
  },
  // ── Loan disbursement / capital injection
  {
    pattern: /loan\s*disbursement|capital\s*injection|owner\s*contribution|proprietor\s*capital/i,
    category: "Capital Introduced",
    transaction_type: "owner_contribution",
    confidence: "High",
    reasoning: "Matches owner capital / loan disbursement keywords",
  },
  // ── Sales / Customer payment
  {
    pattern: /payment\s*received|receipt\s*from|customer\s*payment|client\s*payment|invoice\s*payment|sale\s*proceeds/i,
    category: "Sales",
    transaction_type: "deposit",
    confidence: "Medium",
    reasoning: "Matches customer payment received keywords",
  },
]

function suggestCategory(
  payee: string | undefined,
  description: string | undefined,
  debitOrCredit: string
): SuggestionResult {
  const text = `${payee ?? ""} ${description ?? ""}`.trim()
  const rules = debitOrCredit === "debit" ? DEBIT_RULES : CREDIT_RULES

  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return {
        category: rule.category,
        transaction_type: rule.transaction_type,
        confidence: rule.confidence,
        reasoning: rule.reasoning,
      }
    }
  }

  // No rule matched — sensible defaults
  return {
    category: debitOrCredit === "debit" ? "General Expenses" : "Sales",
    transaction_type: debitOrCredit === "debit" ? "expense" : "deposit",
    confidence: "Low",
    reasoning: "No keyword rule matched — default category assigned. CA review required.",
  }
}

// ─── GL Account Fuzzy Matcher ─────────────────────────────────────────────────

function findAccountId(accounts: GLAccount[], suggestedCategoryName: string): string {
  const needle = suggestedCategoryName.toLowerCase().trim()

  // 1. Exact match (case-insensitive)
  const exact = accounts.find(a => a.account_name.toLowerCase() === needle)
  if (exact) return exact.account_id

  // 2. Needle is contained in account name (e.g. "Bank Charges" in "Bank Charges (Axis)")
  const forward = accounts.find(a => a.account_name.toLowerCase().includes(needle))
  if (forward) return forward.account_id

  // 3. Account name is contained in needle
  const reverse = accounts.find(a => needle.includes(a.account_name.toLowerCase()))
  if (reverse) return reverse.account_id

  return ""
}

// ─── CSV Helpers ──────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "Bank_Account_ID",
  "Transaction_ID",
  "Date",
  "Amount",
  "Debit_Credit",
  "Payee",
  "Description",
  "Reference",
  "AI_Category",
  "AI_Account_ID",
  "AI_Transaction_Type",
  "AI_Confidence",
  "AI_Reasoning",
  "CA_Account_ID",    // ← CA fills: GL account ID for categorization
  "CA_Transaction_Type", // ← CA fills: expense/deposit/transfer_fund/etc.
  "CA_Notes",         // ← CA fills: free text notes
  "Approve",          // ← CA fills: Y to execute
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
      // ── Fetch uncategorized transactions (paginated) ─────────────────────────

      const maxTxns = args.max_transactions ?? 500
      const allTxns: BankStatementTxn[] = []
      let page = 1
      const perPage = 200

      while (allTxns.length < maxTxns) {
        const queryParams: Record<string, string> = {
          status: "uncategorized",
          per_page: String(perPage),
          page: String(page),
        }
        if (args.date_start) queryParams.date_start = args.date_start
        if (args.date_end) queryParams.date_end = args.date_end

        const result = await zohoGet<{ banktransactions: BankStatementTxn[] }>(
          `/bankaccounts/${args.account_id}/statement`,
          args.organization_id,
          queryParams
        )

        if (!result.ok) {
          return `Failed to fetch transactions (page ${page}): ${result.errorMessage}`
        }

        const batch = result.data?.banktransactions ?? []
        allTxns.push(...batch)

        // If fewer than perPage returned, we've reached the last page
        if (batch.length < perPage) break
        page++
      }

      if (allTxns.length === 0) {
        return `✅ No uncategorized transactions found for account \`${args.account_id}\`.${
          args.date_start || args.date_end
            ? ` (Filter: ${args.date_start ?? "any"} → ${args.date_end ?? "any"})`
            : ""
        }`
      }

      // Trim to max
      const txns = allTxns.slice(0, maxTxns)
      const truncated = allTxns.length > maxTxns

      // ── Fetch Chart of Accounts for GL account ID matching ────────────────────

      let accounts: GLAccount[] = []
      const coaResult = await zohoGet<{ chartofaccounts: GLAccount[] }>(
        "/chartofaccounts",
        args.organization_id,
        { per_page: "500" }
      )
      if (coaResult.ok) {
        accounts = coaResult.data?.chartofaccounts ?? []
      }
      // Non-fatal — proceed without COA if fetch fails

      // ── Build CSV ─────────────────────────────────────────────────────────────

      const csvLines: string[] = []
      // UTF-8 BOM for Excel compatibility
      const BOM = "\uFEFF"

      csvLines.push(buildCSVRow(CSV_HEADERS))

      let highCount = 0
      let mediumCount = 0
      let lowCount = 0

      for (const tx of txns) {
        const suggestion = suggestCategory(tx.payee, tx.description, tx.debit_or_credit)

        // Attempt to match suggested category to a real GL account
        const aiAccountId = accounts.length > 0
          ? findAccountId(accounts, suggestion.category)
          : ""

        if (suggestion.confidence === "High") highCount++
        else if (suggestion.confidence === "Medium") mediumCount++
        else lowCount++

        csvLines.push(buildCSVRow([
          args.account_id,
          tx.transaction_id,
          tx.date,
          tx.amount,
          tx.debit_or_credit,
          tx.payee ?? "",
          tx.description ?? "",
          tx.reference_number ?? "",
          suggestion.category,
          aiAccountId,
          suggestion.transaction_type,
          suggestion.confidence,
          suggestion.reasoning,
          "", // CA_Account_ID — blank for CA to fill
          "", // CA_Transaction_Type — blank for CA to fill
          "", // CA_Notes — blank for CA to fill
          "", // Approve — blank for CA to fill
        ]))
      }

      const csvContent = BOM + csvLines.join("\n")

      // ── Optionally write to disk ───────────────────────────────────────────────

      let fileWriteStatus = ""
      if (args.output_path) {
        const pathCheck = validateCSVPath(args.output_path)
        if (!pathCheck.valid || !pathCheck.resolvedPath) {
          fileWriteStatus = `\n⚠️ File NOT written: ${pathCheck.error}`
        } else {
          try {
            const dir = path.dirname(pathCheck.resolvedPath)
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
            }
            fs.writeFileSync(pathCheck.resolvedPath, csvContent, { encoding: "utf8", mode: 0o600 })
            fileWriteStatus = `\n✅ File written: ${pathCheck.resolvedPath}`
          } catch (e) {
            fileWriteStatus = `\n⚠️ File write failed: ${e instanceof Error ? e.message : String(e)}`
          }
        }
      }

      // ── Build response ────────────────────────────────────────────────────────

      const header = [
        `**Reconciliation Export — Account \`${args.account_id}\`**`,
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Transactions exported | ${txns.length}${truncated ? ` (capped at ${maxTxns} — run again with date filters for remainder)` : ""} |`,
        `| AI High confidence | ${highCount} |`,
        `| AI Medium confidence | ${mediumCount} |`,
        `| AI Low confidence (CA must review) | ${lowCount} |`,
        `| GL accounts fetched | ${accounts.length} |`,
        fileWriteStatus ? fileWriteStatus.replace(/^\\n/, "") : "",
        "",
        "**Instructions for CA:**",
        "1. Copy the CSV below into Excel (or save the file if output_path was set)",
        "2. Review AI suggestions — override CA_Account_ID and CA_Transaction_Type where needed",
        "3. Mark **Approve = Y** for each row you approve",
        "4. Save the file",
        "5. Provide the approved CSV to Claude via `import_approved_reconciliation`",
        "",
        "**CA_Transaction_Type valid values:**",
        "  `expense` | `deposit` | `transfer_fund` | `owner_drawings` | `owner_contribution` | `other_income` | `refund`",
        "",
        `**CSV Data** (${txns.length} rows):`,
        "```csv",
      ]
        .filter(line => line !== undefined)
        .join("\n")

      return `${header}\n${csvContent}\n\`\`\``
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
        accountId: string // GL account
        transactionType: string
        notes: string
        validationError?: string
      }

      const plan: ExecutionItem[] = []

      for (let i = 0; i < approvedRows.length; i++) {
        const row = approvedRows[i]
        const rowNum = i + 2 // 1-based, accounting for header row

        const bankAccountId = row["bank_account_id"]?.trim()
        const transactionId = row["transaction_id"]?.trim()
        const date = row["date"]?.trim()
        const rawAmount = row["amount"]?.trim()
        const debitOrCredit = row["debit_or_credit"]?.trim()?.toLowerCase()

        // GL account: CA override takes priority
        const accountId = (row["ca_account_id"]?.trim() || row["ai_account_id"]?.trim()) ?? ""

        // Transaction type: CA override takes priority
        const rawTxnType = (row["ca_transaction_type"]?.trim() || row["ai_transaction_type"]?.trim()) ?? ""
        const transactionType = rawTxnType || (debitOrCredit === "debit" ? "expense" : "deposit")

        const notes = row["ca_notes"]?.trim() ?? ""

        // Validation
        let validationError: string | undefined

        if (!bankAccountId) validationError = "Missing Bank_Account_ID"
        else if (!transactionId) validationError = "Missing Transaction_ID"
        else if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) validationError = "Invalid or missing Date (expected YYYY-MM-DD)"
        else if (!rawAmount || isNaN(Number(rawAmount))) validationError = "Invalid or missing Amount"
        else if (!accountId) validationError = "No GL account ID: fill CA_Account_ID or ensure AI_Account_ID is populated"
        else {
          const validTypes = ["expense", "deposit", "transfer_fund", "owner_contribution", "owner_drawings", "other_income", "refund"]
          if (!validTypes.includes(transactionType)) {
            validationError = `Invalid transaction_type "${transactionType}". Must be one of: ${validTypes.join(", ")}`
          }
        }

        // Security: validate IDs are alphanumeric only (no injection)
        if (!validationError && !/^[a-zA-Z0-9_-]+$/.test(bankAccountId!)) {
          validationError = `Invalid Bank_Account_ID format: "${bankAccountId}"`
        }
        if (!validationError && !/^[a-zA-Z0-9_-]+$/.test(transactionId!)) {
          validationError = `Invalid Transaction_ID format: "${transactionId}"`
        }
        if (!validationError && !/^[a-zA-Z0-9_-]+$/.test(accountId)) {
          validationError = `Invalid GL Account_ID format: "${accountId}"`
        }

        plan.push({
          rowNum,
          bankAccountId: bankAccountId ?? "",
          transactionId: transactionId ?? "",
          date: date ?? "",
          amount: Number(rawAmount ?? 0),
          accountId,
          transactionType,
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
            lines.push(
              `  Row ${item.rowNum}: CATEGORIZE txn \`${item.transactionId}\` → ` +
              `account \`${item.accountId}\` | type: ${item.transactionType} | ` +
              `${item.date} | INR ${item.amount.toLocaleString("en-IN")}`
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
      for (let idx = 0; idx < validItems.length; idx++) {
        const item = validItems[idx]

        // Rate limit: 700 ms between calls (not before the first call)
        if (idx > 0) await sleep(700)

        const payload: Record<string, unknown> = {
          transaction_type: item.transactionType,
          account_id: item.accountId,
          amount: item.amount,
          date: item.date,
        }
        if (item.notes) payload.description = item.notes

        const apiResult = await zohoPost<{ message: string }>(
          `/bankaccounts/${item.bankAccountId}/statement/${item.transactionId}/categorize`,
          args.organization_id,
          payload
        )

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
            message: "Categorized",
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
