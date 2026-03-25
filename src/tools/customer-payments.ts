/**
 * Customer Payment & Bank Transaction Categorization Tools
 * Zoho Books India — Flutch Technology
 *
 * Solves: 450+ uncategorized income transactions (₹9.2 Cr)
 * Pattern: create_customer_payment → get payment_id → categorize_bank_transaction
 *
 * Security controls:
 * - Amount validated: positive, max 2dp, ceiling ₹99.99Cr
 * - Invoice balance pre-checked before applying payment (prevents over-application)
 * - Payment mode enum-locked
 * - Date format enforced YYYY-MM-DD
 * - Sum of amount_applied across invoices validated against total amount
 * - Audit log on every write
 * - No sensitive values in logs (param keys only)
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet, zohoPost } from "../api/client.js"
import { optionalOrganizationIdSchema, entityIdSchema } from "../utils/validation.js"

// ─── Shared Schemas ───────────────────────────────────────────────────────────

const amountSchema = z
  .number()
  .positive("Amount must be greater than zero")
  .max(999_999_999, "Amount exceeds maximum (₹99,99,99,999)")
  .multipleOf(0.01, "Amount cannot have more than 2 decimal places")

const dateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Date must be YYYY-MM-DD")

const paymentModeSchema = z.enum([
  "cash",
  "check",
  "bank_transfer",
  "neft",
  "rtgs",
  "imps",
  "upi",
  "other",
])

const invoiceApplicationSchema = z.object({
  invoice_id: z.string().min(1).describe("Invoice ID to apply payment against"),
  amount_applied: amountSchema.describe("Amount to apply — must not exceed invoice outstanding balance"),
})

// ─── Audit Logger ─────────────────────────────────────────────────────────────

function auditLog(tool: string, org: string | undefined, status: "INITIATED" | "SUCCESS" | "FAILED", entityId?: string, error?: string) {
  console.log(JSON.stringify({
    audit: true,
    timestamp: new Date().toISOString(),
    tool,
    organization_id: org || "ENV_DEFAULT",
    status,
    ...(entityId ? { entity_id: entityId } : {}),
    ...(error ? { error } : {}),
  }))
}

// ─── Register Tools ───────────────────────────────────────────────────────────

export function registerCustomerPaymentTools(server: FastMCP): void {

  // ─── Tool 1: create_customer_payment ──────────────────────────────────────

  server.addTool({
    name: "create_customer_payment",
    description: `Create a Customer Payment in Zoho Books and apply it against one or more invoices.

HOW TO USE:
1. Get customer_id from list_contacts
2. Get account_id (bank account) from list_bank_accounts
3. Get invoice_id from list_invoices
4. This tool validates invoice balance before posting — rejects over-application
5. After this succeeds, use categorize_bank_transaction to link the bank feed entry

RETURNS: payment_id — required for categorize_bank_transaction

India payment modes: neft, rtgs, imps, upi, bank_transfer`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      customer_id: z.string().min(1).describe("Customer contact ID from list_contacts"),
      amount: amountSchema.describe("Total payment amount received from customer"),
      date: dateSchema.describe("Payment receipt date (YYYY-MM-DD)"),
      account_id: entityIdSchema.describe("Bank account ID where payment was received (from list_bank_accounts)"),
      payment_mode: paymentModeSchema.describe("Payment mode — use neft/rtgs/imps/upi for bank transfers"),
      reference_number: z
        .string()
        .max(100)
        .optional()
        .describe("NEFT UTR / RTGS reference / cheque number — critical for audit trail"),
      bank_charges: z
        .number()
        .min(0)
        .max(100000)
        .optional()
        .describe("Bank charges deducted (if any). Default: 0"),
      invoices: z
        .array(invoiceApplicationSchema)
        .min(1)
        .max(10)
        .describe("Invoices to apply this payment against. Sum of amount_applied must not exceed total amount."),
    }),
    annotations: {
      title: "Create Customer Payment",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      // ── Guard 1: sum of applied must not exceed total ──────────────────────
      const totalApplied = args.invoices.reduce((sum, inv) => sum + inv.amount_applied, 0)
      if (totalApplied > args.amount + 0.01) {
        return `❌ Validation failed: Total applied (INR ${totalApplied.toLocaleString("en-IN")}) exceeds payment amount (INR ${args.amount.toLocaleString("en-IN")}). Reduce amount_applied values.`
      }

      // ── Guard 2: check each invoice balance before posting ─────────────────
      for (const inv of args.invoices) {
        const invResult = await zohoGet<{ invoice: any }>(
          `/invoices/${inv.invoice_id}`,
          args.organization_id
        )
        if (!invResult.ok) {
          return `❌ Could not verify invoice ${inv.invoice_id}: ${invResult.errorMessage || "fetch failed"}. Aborting — no payment posted.`
        }
        const invoice = invResult.data?.invoice
        if (!invoice) {
          return `❌ Invoice ${inv.invoice_id} not found. Verify the invoice_id and try again.`
        }
        if (invoice.status === "void") {
          return `❌ Invoice ${inv.invoice_id} is voided — cannot apply payment against a void invoice.`
        }
        if (invoice.status === "paid") {
          return `❌ Invoice ${inv.invoice_id} is already fully paid (balance = 0). No payment needed.`
        }
        const balance = parseFloat(String(invoice.balance || 0))
        if (inv.amount_applied > balance + 0.01) {
          return `❌ Over-application on invoice ${inv.invoice_id}: attempting to apply INR ${inv.amount_applied.toLocaleString("en-IN")} but outstanding balance is only INR ${balance.toLocaleString("en-IN")}. Adjust amount_applied (TDS remainder stays open — correct behaviour).`
        }
      }

      // ── Post payment ────────────────────────────────────────────────────────
      auditLog("create_customer_payment", args.organization_id, "INITIATED")

      const payload: Record<string, unknown> = {
        customer_id: args.customer_id,
        payment_mode: args.payment_mode,
        amount: args.amount,
        date: args.date,
        account_id: args.account_id,
        invoices: args.invoices.map(inv => ({
          invoice_id: inv.invoice_id,
          amount_applied: inv.amount_applied,
        })),
        bank_charges: args.bank_charges ?? 0,
      }
      if (args.reference_number) payload.reference_number = args.reference_number

      const result = await zohoPost<{ payment: any }>(
        "/customerpayments",
        args.organization_id,
        payload
      )

      if (!result.ok) {
        auditLog("create_customer_payment", args.organization_id, "FAILED", undefined, result.errorMessage || "unknown")
        return `❌ Payment failed: ${result.errorMessage || "Unknown error from Zoho API"}`
      }

      const payment = result.data?.payment
      const paymentId = payment?.payment_id || payment?.customerpayment_id

      auditLog("create_customer_payment", args.organization_id, "SUCCESS", paymentId)

      const unused = args.amount - totalApplied
      const invoiceSummary = args.invoices
        .map(inv => `   • Invoice \`${inv.invoice_id}\` — INR ${inv.amount_applied.toLocaleString("en-IN")} applied`)
        .join("\n")

      return `✅ **Customer Payment Created**

- **Payment ID**: \`${paymentId}\`
- **Date**: ${args.date}
- **Amount**: INR ${args.amount.toLocaleString("en-IN")}
- **Mode**: ${args.payment_mode}
- **Reference**: ${args.reference_number || "N/A"}
- **Applied to**:
${invoiceSummary}
- **Unused Credit**: INR ${unused.toLocaleString("en-IN")}

**Next step**: Run \`categorize_bank_transaction\` with this payment_id (\`${paymentId}\`) to link the bank feed entry and mark it as categorized.`
    },
  })

  // ─── Tool 2: categorize_bank_transaction ─────────────────────────────────

  server.addTool({
    name: "categorize_bank_transaction",
    description: `Link an existing uncategorized bank feed transaction to a Customer Payment, Expense, or Transfer.

WHEN TO USE:
- After create_customer_payment: link the bank deposit to the payment (clears uncategorized status)
- After create_expense: link the bank debit to the expense record
- For inter-account transfers: categorize as transfer

WORKFLOW:
1. list_bank_transactions with status=uncategorized → get transaction_id
2. create_customer_payment → get payment_id
3. categorize_bank_transaction (this tool) → bank entry marked as Categorized

This eliminates double-counting: the existing bank feed entry is LINKED (not duplicated).`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema.describe(
        "Zoho org ID (uses ZOHO_ORGANIZATION_ID env var if not provided)"
      ),
      account_id: entityIdSchema.describe("Bank account ID containing the uncategorized transaction"),
      transaction_id: z
        .string()
        .min(1)
        .describe("Zoho bank transaction ID — get from list_bank_transactions with status=uncategorized"),
      transaction_type: z
        .enum(["customer_payment", "expense", "transfer_fund"])
        .describe("Type of transaction: customer_payment (income), expense (debit), transfer_fund (own-account transfer)"),
      linked_transaction_id: z
        .string()
        .min(1)
        .describe("The payment_id from create_customer_payment, or expense_id from create_expense"),
    }),
    annotations: {
      title: "Categorize Bank Transaction",
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args) => {
      auditLog("categorize_bank_transaction", args.organization_id, "INITIATED")

      const payload: Record<string, unknown> = {
        transaction_type: args.transaction_type,
        transaction_id: args.linked_transaction_id,
      }

      const result = await zohoPost<{ message: string }>(
        `/bankaccounts/${args.account_id}/transactions/${args.transaction_id}/categorize`,
        args.organization_id,
        payload
      )

      if (!result.ok) {
        auditLog("categorize_bank_transaction", args.organization_id, "FAILED", undefined, result.errorMessage || "unknown")

        // Helpful error guidance for common failures
        const errMsg = result.errorMessage || ""
        if (errMsg.toLowerCase().includes("already categorized")) {
          return `⚠️ Transaction \`${args.transaction_id}\` is already categorized — no action needed. Check Zoho Books bank feed to confirm.`
        }
        if (errMsg.toLowerCase().includes("not found")) {
          return `❌ Transaction \`${args.transaction_id}\` not found in account \`${args.account_id}\`. Verify the account_id and transaction_id from list_bank_transactions.`
        }
        return `❌ Categorization failed: ${errMsg || "Unknown error from Zoho API"}`
      }

      auditLog("categorize_bank_transaction", args.organization_id, "SUCCESS", args.transaction_id)

      return `✅ **Bank Transaction Categorized**

- **Bank Transaction ID**: \`${args.transaction_id}\`
- **Linked to**: \`${args.linked_transaction_id}\` (${args.transaction_type})
- **Account**: \`${args.account_id}\`
- **Status**: Categorized ✓

Bank feed entry is now matched — no double-count. AR ageing will update on next Zoho refresh.`
    },
  })
}
