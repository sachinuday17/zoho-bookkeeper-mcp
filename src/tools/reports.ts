/**
 * Financial Reports Tools — Zoho Books India
 * All tools are READ-ONLY — zero write risk.
 * Used for financial review before approvals.
 */

import { z } from "zod"
import type { FastMCP } from "fastmcp"
import { zohoGet } from "../api/client.js"
import { optionalOrganizationIdSchema } from "../utils/validation.js"
import { dateSchema } from "../utils/validators.js"

function formatReportData(data: any, title: string, period: string): string {
  if (!data) return `No data returned for ${title}.`
  // Return structured summary — full data is in JSON for programmatic use
  return `**${title}** (${period})\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
}

export function registerReportTools(server: FastMCP): void {

  // ─── Balance Sheet ───────────────────────────────────────────────────────

  server.addTool({
    name: "get_balance_sheet",
    description: `Fetch the Balance Sheet from Zoho Books.
Returns Assets, Liabilities, and Equity as of the specified date.
Use before period close or for financial review.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      date: dateSchema.describe("As-of date (YYYY-MM-DD). Use last day of the period."),
    }),
    annotations: { title: "Balance Sheet", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/balancesheet", args.organization_id, { date: args.date })
      if (!result.ok) return result.errorMessage || "Failed to fetch balance sheet"
      return formatReportData(result.data, "Balance Sheet", `as of ${args.date}`)
    },
  })

  // ─── Profit & Loss ───────────────────────────────────────────────────────

  server.addTool({
    name: "get_profit_and_loss",
    description: `Fetch the Profit & Loss Statement from Zoho Books.
Returns Income, COGS, Gross Profit, Expenses, and Net Profit for the period.
Set cash_basis=true for cash-basis accounting (default is accrual).`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      from_date: dateSchema,
      to_date: dateSchema,
      cash_basis: z.boolean().optional().describe("Use cash basis (default: accrual)"),
    }),
    annotations: { title: "Profit & Loss", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const queryParams: Record<string, string> = {
        from_date: args.from_date,
        to_date: args.to_date,
      }
      if (args.cash_basis) queryParams.cash_basis = "true"
      const result = await zohoGet<any>("/reports/profitandloss", args.organization_id, queryParams)
      if (!result.ok) return result.errorMessage || "Failed to fetch P&L"
      return formatReportData(result.data, "Profit & Loss", `${args.from_date} to ${args.to_date}`)
    },
  })

  // ─── Trial Balance ───────────────────────────────────────────────────────

  server.addTool({
    name: "get_trial_balance",
    description: `Fetch the Trial Balance from Zoho Books.
Returns debit and credit totals for all accounts.
Use before finalizing period close — verify totals balance before GST return filing.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      from_date: dateSchema,
      to_date: dateSchema,
    }),
    annotations: { title: "Trial Balance", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/trialbalance", args.organization_id, {
        from_date: args.from_date,
        to_date: args.to_date,
      })
      if (!result.ok) return result.errorMessage || "Failed to fetch trial balance"
      return formatReportData(result.data, "Trial Balance", `${args.from_date} to ${args.to_date}`)
    },
  })

  // ─── Cash Flow ───────────────────────────────────────────────────────────

  server.addTool({
    name: "get_cash_flow",
    description: `Fetch the Cash Flow Statement from Zoho Books.
Returns Operating, Investing, and Financing activities.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      from_date: dateSchema,
      to_date: dateSchema,
    }),
    annotations: { title: "Cash Flow Statement", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/cashflow", args.organization_id, {
        from_date: args.from_date,
        to_date: args.to_date,
      })
      if (!result.ok) return result.errorMessage || "Failed to fetch cash flow"
      return formatReportData(result.data, "Cash Flow Statement", `${args.from_date} to ${args.to_date}`)
    },
  })

  // ─── AR Aging ────────────────────────────────────────────────────────────

  server.addTool({
    name: "get_ar_aging",
    description: `Fetch Accounts Receivable Aging report.
Groups outstanding customer invoices into age buckets: 0-30, 31-60, 61-90, 90+ days.
Critical for collections management and cash flow forecasting.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      as_of_date: dateSchema.describe("As-of date (YYYY-MM-DD)"),
    }),
    annotations: { title: "AR Aging", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/aging", args.organization_id, { as_of_date: args.as_of_date })
      if (!result.ok) return result.errorMessage || "Failed to fetch AR aging"
      return formatReportData(result.data, "Accounts Receivable Aging", `as of ${args.as_of_date}`)
    },
  })

  // ─── AP Aging ────────────────────────────────────────────────────────────

  server.addTool({
    name: "get_ap_aging",
    description: `Fetch Accounts Payable Aging report.
Groups outstanding vendor bills into age buckets: 0-30, 31-60, 61-90, 90+ days.
Use for payment planning and avoiding vendor penalties.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      as_of_date: dateSchema.describe("As-of date (YYYY-MM-DD)"),
    }),
    annotations: { title: "AP Aging", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/vendorageing", args.organization_id, { as_of_date: args.as_of_date })
      if (!result.ok) return result.errorMessage || "Failed to fetch AP aging"
      return formatReportData(result.data, "Accounts Payable Aging", `as of ${args.as_of_date}`)
    },
  })

  // ─── Sales by Customer ───────────────────────────────────────────────────

  server.addTool({
    name: "get_sales_by_customer",
    description: `Sales analysis by customer for the period.
Shows invoiced amount, collections, and outstanding per customer.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      from_date: dateSchema,
      to_date: dateSchema,
    }),
    annotations: { title: "Sales by Customer", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/salescustomer", args.organization_id, {
        from_date: args.from_date,
        to_date: args.to_date,
      })
      if (!result.ok) return result.errorMessage || "Failed to fetch sales by customer"
      return formatReportData(result.data, "Sales by Customer", `${args.from_date} to ${args.to_date}`)
    },
  })

  // ─── Expense by Category ─────────────────────────────────────────────────

  server.addTool({
    name: "get_expense_by_category",
    description: `Expense analysis by account/category for the period.
Use for budget vs actual comparison and cost control.`,
    parameters: z.object({
      organization_id: optionalOrganizationIdSchema,
      from_date: dateSchema,
      to_date: dateSchema,
    }),
    annotations: { title: "Expense by Category", readOnlyHint: true, openWorldHint: true },
    execute: async (args) => {
      const result = await zohoGet<any>("/reports/expensebycategory", args.organization_id, {
        from_date: args.from_date,
        to_date: args.to_date,
      })
      if (!result.ok) return result.errorMessage || "Failed to fetch expense by category"
      return formatReportData(result.data, "Expense by Category", `${args.from_date} to ${args.to_date}`)
    },
  })
}
