/**
 * Zoho Bookkeeper MCP Server
 *
 * Multi-client Zoho Books automation for CA firms.
 * One server, unlimited clients — switch with set_active_client("slug").
 *
 * Security:
 *   Set MCP_API_KEY env var to enable Bearer token authentication.
 *   Without it the server is open (development mode only — never in production).
 */

import { FastMCP } from "fastmcp"
import type { IncomingMessage } from "http"
import { getServerConfig } from "./config.js"

// ── Tool registrations ────────────────────────────────────────────────────────
import { registerClientSwitcherTools } from "./tools/client-switcher.js"
import { registerOrganizationTools } from "./tools/organizations.js"
import { registerChartOfAccountsTools } from "./tools/chart-of-accounts.js"
import { registerJournalTools } from "./tools/journals.js"
import { registerExpenseTools } from "./tools/expenses.js"
import { registerBillTools } from "./tools/bills.js"
import { registerInvoiceTools } from "./tools/invoices.js"
import { registerInvoiceWriteTools } from "./tools/invoices-write.js"
import { registerContactTools } from "./tools/contacts.js"
import { registerContactWriteTools } from "./tools/contacts-write.js"
import { registerBankAccountTools } from "./tools/bank-accounts.js"
import { registerBankReconciliationTools } from "./tools/bank-reconciliation.js"
import { registerPaymentTools } from "./tools/payments.js"
import { registerCustomerPaymentTools } from "./tools/customer-payments.js"
import { registerReportTools } from "./tools/reports.js"
import { registerIndiaGSTTools } from "./tools/india-gst.js"
import { registerItemTools } from "./tools/items.js"

const { apiKey } = getServerConfig()

// ── Server creation ───────────────────────────────────────────────────────────

const serverOptions: ConstructorParameters<typeof FastMCP>[0] = {
  name: "zoho-bookkeeper-mcp",
  version: "2.0.0",
  instructions: `
Zoho Books MCP server for multi-client bookkeeping automation.

## Quick Start
1. Call list_clients to see configured companies
2. Call set_active_client("slug") to switch to the right company
3. All tools then operate on that company's Zoho Books account

## Organization ID
Pre-configured per client via env vars — you do NOT need to pass organization_id.
It is accepted as an optional override if needed.

## Available Tool Groups

### Client Management
- list_clients, set_active_client, get_active_client, refresh_client_token

### Bank Reconciliation (Step-by-step)
- import_bank_statement         — upload CSV/OFX/QIF
- list_bank_statement_transactions — view uncategorized entries
- get_reconciliation_summary    — progress %
- analyse_uncategorized_patterns — group by payee, suggest rules
- find_matching_invoices         — smart match for credits
- find_matching_bills            — smart match for debits
- match_bank_transaction         — link to existing invoice/bill
- categorize_bank_statement_transaction — post to GL account
- exclude_bank_transaction       — exclude duplicates/transfers
- bulk_categorize_transactions   — batch process multiple entries
- create_bank_rule, list_bank_rules — auto-categorization rules

### Bank Accounts
- list_bank_accounts, get_bank_account, list_bank_transactions

### Chart of Accounts
- list_accounts, get_account, create_account, list_account_transactions

### Journals
- list_journals, get_journal, create_journal, update_journal, delete_journal, publish_journal
- add_journal_attachment, get_journal_attachment, delete_journal_attachment

### Invoices
- list_invoices, get_invoice, create_invoice, update_invoice, void_invoice, delete_invoice
- mark_invoice_sent, email_invoice, add_invoice_payment
- add_invoice_attachment, get_invoice_attachment, delete_invoice_attachment

### Bills
- list_bills, get_bill, create_bill
- add_bill_attachment, get_bill_attachment, delete_bill_attachment

### Expenses
- list_expenses, get_expense, create_expense
- add_expense_receipt, get_expense_receipt, delete_expense_receipt

### Contacts
- list_contacts, get_contact, create_contact, update_contact, set_contact_status
- get_contact_statement

### Payments
- list_customer_payments, get_customer_payment, create_customer_payment, delete_customer_payment
- list_vendor_payments, get_vendor_payment, create_vendor_payment

### Items
- list_items, get_item, create_item, update_item, delete_item

### Reports
- get_balance_sheet, get_profit_and_loss, get_trial_balance, get_cash_flow
- get_ar_aging, get_ap_aging, get_sales_by_customer, get_expense_by_category

### India GST
- get_gstr1_summary, get_gstr2_summary, get_hsn_summary, get_tds_summary
- generate_einvoice, cancel_einvoice, generate_eway_bill

### Organizations
- list_organizations, get_organization
`,
  health: {
    enabled: true,
    message: JSON.stringify({
      status: "healthy",
      service: "zoho-bookkeeper-mcp",
      version: "2.0.0",
      timestamp: new Date().toISOString(),
      auth: apiKey ? "bearer-token" : "open",
    }),
    path: "/health",
    status: 200,
  },
}

// ── API key authentication ────────────────────────────────────────────────────
// Only enabled when MCP_API_KEY env var is set.
// FastMCP v3 authenticate receives { headers } and should throw to reject.

if (apiKey) {
  serverOptions.authenticate = async (request: IncomingMessage) => {
    const rawHeader = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : (request.headers.authorization ?? "")
    const token = rawHeader.startsWith("Bearer ")
      ? rawHeader.slice(7)
      : rawHeader

    if (!token || token !== apiKey) {
      throw new Error("Unauthorized: invalid or missing API key")
    }
    return {}
  }
  console.log("[security] API key authentication enabled")
} else {
  console.warn(
    "[security] WARNING: MCP_API_KEY is not set — server is open. " +
    "Set MCP_API_KEY in Railway environment variables before production use."
  )
}

const server = new FastMCP(serverOptions)

// ── Register tools (order matters — no duplicates) ────────────────────────────

// Client management — always first so users can switch context immediately
registerClientSwitcherTools(server)

// Organization
registerOrganizationTools(server)

// Core accounting
registerChartOfAccountsTools(server)
registerJournalTools(server)
registerExpenseTools(server)
registerBillTools(server)
registerInvoiceTools(server)
registerInvoiceWriteTools(server)
registerContactTools(server)
registerContactWriteTools(server)
registerItemTools(server)

// Payments
registerPaymentTools(server)
registerCustomerPaymentTools(server)

// Banking & Reconciliation
// Note: bank-accounts.ts contains ONLY list/get/transactions
//       bank-reconciliation.ts owns ALL statement-feed and categorization tools
registerBankAccountTools(server)
registerBankReconciliationTools(server)

// Reports & GST
registerReportTools(server)
registerIndiaGSTTools(server)

export default server
