/**
 * Zoho Bookkeeper MCP Server
 *
 * A Model Context Protocol server for Zoho Books integration with proper
 * multipart file upload support for attachments.
 */

import { FastMCP } from "fastmcp"

// Tool registrations
import { registerOrganizationTools } from "./tools/organizations.js"
import { registerChartOfAccountsTools } from "./tools/chart-of-accounts.js"
import { registerJournalTools } from "./tools/journals.js"
import { registerExpenseTools } from "./tools/expenses.js"
import { registerBillTools } from "./tools/bills.js"
import { registerInvoiceTools } from "./tools/invoices.js"
import { registerContactTools } from "./tools/contacts.js"
import { registerBankAccountTools } from "./tools/bank-accounts.js"

// Create the MCP server
const server = new FastMCP({
  name: "zoho-bookkeeper-mcp",
  version: "1.0.0",
  instructions: `
Zoho Books MCP server for bookkeeping workflows.

## Organization ID
The organization_id is pre-configured via ZOHO_ORGANIZATION_ID environment variable.
You do NOT need to call list_organizations first - just use the tools directly.

## Available Tools

### Chart of Accounts
- list_accounts: List all accounts (find account_id values here)
- get_account: Get account details
- create_account: Create new account
- list_account_transactions: List transactions for an account

### Journals
- list_journals, get_journal, create_journal, update_journal, delete_journal, publish_journal
- add_journal_attachment, get_journal_attachment, delete_journal_attachment

### Expenses
- list_expenses, get_expense, create_expense
- add_expense_receipt, get_expense_receipt, delete_expense_receipt

### Bills
- list_bills, get_bill, create_bill
- add_bill_attachment, get_bill_attachment, delete_bill_attachment

### Invoices
- list_invoices, get_invoice
- add_invoice_attachment, get_invoice_attachment, delete_invoice_attachment

### Contacts & Bank Accounts
- list_contacts, get_contact
- list_bank_accounts, get_bank_account, list_bank_transactions

### Organizations (rarely needed)
- list_organizations, get_organization
`,
  health: {
    enabled: true,
    message: JSON.stringify({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      service: "zoho-bookkeeper-mcp",
    }),
    path: "/health",
    status: 200,
  },
})

// Register all tools
registerOrganizationTools(server)
registerChartOfAccountsTools(server)
registerJournalTools(server)
registerExpenseTools(server)
registerBillTools(server)
registerInvoiceTools(server)
registerContactTools(server)
registerBankAccountTools(server)

export default server
