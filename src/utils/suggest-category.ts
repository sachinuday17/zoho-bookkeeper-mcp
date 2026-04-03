/**
 * India-specific bank transaction category suggestion engine
 *
 * Shared between:
 *   - reconciliation-export.ts  (export CSV with AI suggestions)
 *   - reconciliation-auto.ts    (auto-categorize high-confidence transactions)
 *
 * Rules are applied in priority order — first match wins.
 * Confidence levels:
 *   High   — strong, unambiguous keyword match → safe to auto-execute
 *   Medium — plausible keyword match → require CA review before executing
 *   Low    — no rule matched → MUST be reviewed by CA
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SuggestionResult {
  category: string        // human-readable GL account name (for COA fuzzy lookup)
  transaction_type: string // Zoho categorize API value
  confidence: "High" | "Medium" | "Low"
  reasoning: string
}

export interface GLAccount {
  account_id: string
  account_name: string
  account_type?: string
}

interface SuggestionRule {
  pattern: RegExp
  category: string
  transaction_type: string
  confidence: "High" | "Medium" | "Low"
  reasoning: string
}

// ─── Debit rules (money out) ──────────────────────────────────────────────────

const DEBIT_RULES: SuggestionRule[] = [
  // ── Self / inter-account transfer — check FIRST before any expense rule
  {
    pattern: /self\s*transfer|own\s*transfer|inter.?account|transfer\s*to\s*(self|own|savings|current|sweep)|between\s*accounts|fd\s*created/i,
    category: "Bank Transfer",
    transaction_type: "transfer_fund",
    confidence: "High",
    reasoning: "Matches inter-account / self-transfer keywords",
  },
  // ── Bank charges
  {
    pattern: /bank\s*(charge|fee|service|charges|commission|annual\s*fee|processing\s*fee|chgs)|neft\s*(charge|fee)|rtgs\s*(charge|fee)|imps\s*(charge|fee)|sms\s*alert|cash\s*handling|dd\s*charge|cheque\s*return/i,
    category: "Bank Charges",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches bank charge / fee keywords",
  },
  // ── GST / Tax payments
  {
    pattern: /gst\s*(payment|challan|paid|payable|deposit)|igst|cgst|sgst|utgst|tds\s*(payment|deposit|challan)|advance\s*tax|income\s*tax\s*(payment|challan|installment)|tax\s*challan|nsdl|oltas|traces|e.?challan/i,
    category: "Tax Payments",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches GST / TDS / advance tax payment keywords",
  },
  // ── Salary / Payroll
  {
    pattern: /\bsalary\b|payroll|wages\b|staff\s*payment|employee\s*payment|\bsal\b|pay\s*slip|payslip|compensation|monthly\s*pay/i,
    category: "Salaries and Wages",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches salary / payroll / wages keywords",
  },
  // ── PF / ESI / PT (statutory deductions)
  {
    pattern: /\bepfo\b|provident\s*fund|pf\s*(contribution|payment|deposit)|\besi\b|professional\s*tax|\bpt\b/i,
    category: "Employee Benefits",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches PF / ESI / professional tax statutory contribution keywords",
  },
  // ── Rent
  {
    pattern: /\brent\b|rental\s*payment|lease\s*payment|office\s*rent|shop\s*rent|godown\s*rent|warehouse\s*rent|co.?working/i,
    category: "Rent Expense",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches rent / lease keywords",
  },
  // ── Electricity / Power boards (India)
  {
    pattern: /electricity|power\s*bill|\bbses\b|\bmseb\b|\btneb\b|\bbescom\b|\bhescom\b|\btsspdcl\b|\bapspdcl\b|\bwbsedcl\b|\bjvvnl\b|\buppcl\b|\bcesc\b|\btorrent\s*power\b|electric\s*bill/i,
    category: "Electricity Expense",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches electricity / power board keywords",
  },
  // ── Water / Municipal
  {
    pattern: /water\s*bill|water\s*supply|water\s*tax|\bbwssb\b|\bnmmc\b|\bmcgm\b\s*water|municipal.*water/i,
    category: "Utilities",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches water supply / municipality keywords",
  },
  // ── Telecom / Internet / Mobile
  {
    pattern: /\bairtel\b|\bjio\b|\bvodafone\b|\bidea\b|\bvi\b\s*(limited|ltd|recharge)?|\bbsnl\b|\bmtnl\b|internet\s*bill|broadband|telecom|mobile\s*bill|data\s*plan|recharge\s*(broadband|postpaid)/i,
    category: "Telephone Expense",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches telecom / internet provider keywords",
  },
  // ── Loan / EMI repayment
  {
    pattern: /\bemi\b|loan\s*(repayment|installment|emi|payment|due)|term\s*loan|home\s*loan|car\s*loan|vehicle\s*loan|od\s*repayment|cc\s*repayment|credit\s*card\s*payment|loan\s*emi/i,
    category: "Loan Repayments",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches EMI / loan repayment keywords",
  },
  // ── Insurance premiums
  {
    pattern: /insurance\s*premium|\blic\b|hdfc\s*life|icici\s*(pru|lombard)|bajaj\s*allianz|star\s*health|new\s*india\s*assurance|national\s*insurance|united\s*india|oriental\s*insurance|reliance\s*general|tata\s*aig/i,
    category: "Insurance Expense",
    transaction_type: "expense",
    confidence: "High",
    reasoning: "Matches insurance premium / company keywords",
  },
  // ── Professional fees
  {
    pattern: /professional\s*fee|consultant\s*fee|consulting\s*charges|legal\s*fee|advocate\s*fee|audit\s*fee|ca\s*fee|retainer\s*fee|advisory\s*fee|legal\s*charges/i,
    category: "Professional Fees",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches professional / legal / audit fee keywords",
  },
  // ── Advertising / Marketing
  {
    pattern: /google\s*ads|facebook\s*ads|meta\s*ads|youtube\s*ads|instagram\s*ads|linkedin\s*ads|advertising\s*(payment|charges)|ad\s*spend|digital\s*marketing|seo\s*charges/i,
    category: "Advertising Expense",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches advertising / digital marketing keywords",
  },
  // ── Travel / Transport
  {
    pattern: /\btravel\b|\bhotel\b|flight\s*ticket|air\s*ticket|\birctc\b|air\s*india|indigo\s*airlines|vistara|spicejet|go\s*first|\buber\b|\bola\b|cab\s*fare|taxi\s*charges|train\s*ticket|boarding\s*pass|lodging|accommodation/i,
    category: "Travel Expenses",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches travel / hotel / flight / cab keywords",
  },
  // ── Software / Subscriptions
  {
    pattern: /subscription\s*fee|\bzoho\b|\btally\b|quickbooks|microsoft\s*(365|office)|google\s*workspace|\baws\b|amazon\s*web\s*services|\bazure\b|hosting\s*(charges|fee)|domain\s*(renewal|registration)|saas\s*subscription/i,
    category: "Software Subscriptions",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches software / SaaS subscription keywords",
  },
  // ── Maintenance / Repairs
  {
    pattern: /maintenance\s*(charges|fee)|repairs?\s*(and\s*maintenance)?|amc\s*(charges|fee)|annual\s*maintenance/i,
    category: "Repairs and Maintenance",
    transaction_type: "expense",
    confidence: "Medium",
    reasoning: "Matches maintenance / repair / AMC keywords",
  },
  // ── Office supplies
  {
    pattern: /stationery|office\s*supply|office\s*supplies|printing\s*charges|cartridge|paper\s*(ream|a4)|\bamazon\b|\bflipcart\b|\bmeesho\b|\bzepto\b/i,
    category: "Office Supplies",
    transaction_type: "expense",
    confidence: "Low",
    reasoning: "Matches office supply / e-commerce keywords — could be personal",
  },
  // ── Owner drawings
  {
    pattern: /drawings|proprietor\s*withdrawal|owner\s*withdrawal|personal\s*withdrawal/i,
    category: "Owner Drawings",
    transaction_type: "owner_drawings",
    confidence: "High",
    reasoning: "Matches owner drawings / proprietor withdrawal keywords",
  },
]

// ─── Credit rules (money in) ──────────────────────────────────────────────────

const CREDIT_RULES: SuggestionRule[] = [
  // ── Bank / FD interest income
  {
    pattern: /interest\s*(credit|earned|income|on\s*savings|on\s*fd|on\s*deposit|on\s*od)|savings\s*account\s*interest|fd\s*interest|fixed\s*deposit\s*interest|od\s*interest/i,
    category: "Interest Income",
    transaction_type: "other_income",
    confidence: "High",
    reasoning: "Matches bank / FD interest income keywords",
  },
  // ── GST / Tax refund
  {
    pattern: /gst\s*refund|tax\s*refund|income\s*tax\s*refund|tds\s*refund|it\s*refund/i,
    category: "Tax Refund",
    transaction_type: "other_income",
    confidence: "High",
    reasoning: "Matches GST / income-tax refund keywords",
  },
  // ── Capital / Loan proceeds
  {
    pattern: /capital\s*injection|owner\s*contribution|proprietor\s*capital|loan\s*disbursement|loan\s*proceeds|od\s*limit\s*credit/i,
    category: "Capital Introduced",
    transaction_type: "owner_contribution",
    confidence: "High",
    reasoning: "Matches owner capital / loan disbursement keywords",
  },
  // ── FD maturity / sweep-in
  {
    pattern: /fd\s*maturity|fixed\s*deposit\s*maturity|sweep.?in\s*credit|sweep\s*account\s*credit/i,
    category: "Bank Transfer",
    transaction_type: "transfer_fund",
    confidence: "High",
    reasoning: "Matches FD maturity / sweep-in credit — likely inter-account transfer",
  },
  // ── Cashback / Refund
  {
    pattern: /cashback|refund\s*received|reversal|credit\s*note|return\s*credit|clawback|reward\s*credit/i,
    category: "Other Income",
    transaction_type: "refund",
    confidence: "Medium",
    reasoning: "Matches cashback / refund / reversal keywords",
  },
  // ── Customer payment (generic — lower confidence, could be anything)
  {
    pattern: /payment\s*received|receipt\s*from|customer\s*payment|client\s*payment|invoice\s*payment|sale\s*proceeds|advance\s*received/i,
    category: "Sales",
    transaction_type: "deposit",
    confidence: "Medium",
    reasoning: "Matches customer payment received keywords",
  },
]

// ─── Public functions ─────────────────────────────────────────────────────────

/**
 * Suggest a GL category for a bank transaction based on payee + description text.
 * Returns the first matching rule result, or a Low-confidence default.
 */
export function suggestCategory(
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

  // No rule matched
  return {
    category: debitOrCredit === "debit" ? "General Expenses" : "Sales",
    transaction_type: debitOrCredit === "debit" ? "expense" : "deposit",
    confidence: "Low",
    reasoning: "No keyword rule matched — default assigned. CA review required.",
  }
}

/**
 * Fuzzy-match a suggested category name to a real GL account_id.
 * Priority: exact → forward substring → reverse substring.
 * Returns empty string if no match found.
 */
export function findAccountId(accounts: GLAccount[], suggestedCategoryName: string): string {
  const needle = suggestedCategoryName.toLowerCase().trim()
  if (!needle) return ""

  const exact = accounts.find(a => a.account_name.toLowerCase() === needle)
  if (exact) return exact.account_id

  const forward = accounts.find(a => a.account_name.toLowerCase().includes(needle))
  if (forward) return forward.account_id

  const reverse = accounts.find(a => needle.includes(a.account_name.toLowerCase()))
  if (reverse) return reverse.account_id

  return ""
}
