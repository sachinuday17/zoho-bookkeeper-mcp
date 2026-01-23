/**
 * Tests for MCP Tool functions
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { FastMCP } from "fastmcp"

// Mock the API client
vi.mock("../../api/client.js", () => ({
  zohoListOrganizations: vi.fn(),
  zohoGet: vi.fn(),
  zohoPost: vi.fn(),
}))

import { zohoListOrganizations, zohoGet, zohoPost } from "../../api/client.js"
import { registerOrganizationTools } from "../../tools/organizations.js"
import { registerContactTools } from "../../tools/contacts.js"
import { registerChartOfAccountsTools } from "../../tools/chart-of-accounts.js"

const mockZohoListOrganizations = vi.mocked(zohoListOrganizations)
const mockZohoGet = vi.mocked(zohoGet)
const mockZohoPost = vi.mocked(zohoPost)

describe("MCP Tools", () => {
  let server: FastMCP
  let tools: Map<string, { execute: (args: Record<string, unknown>) => Promise<string> }>

  beforeEach(() => {
    vi.clearAllMocks()
    tools = new Map()

    // Create a mock server that captures tool registrations
    server = {
      addTool: vi.fn(
        (tool: { name: string; execute: (args: Record<string, unknown>) => Promise<string> }) => {
          tools.set(tool.name, tool)
        }
      ),
    } as unknown as FastMCP
  })

  describe("Organization Tools", () => {
    beforeEach(() => {
      registerOrganizationTools(server)
    })

    describe("list_organizations", () => {
      it("lists organizations successfully", async () => {
        mockZohoListOrganizations.mockResolvedValue({
          ok: true,
          data: {
            organizations: [
              {
                organization_id: "org-123",
                name: "Test Org",
                is_default_org: true,
                currency_code: "USD",
                currency_symbol: "$",
                time_zone: "America/New_York",
                fiscal_year_start_month: 1,
              },
            ],
          },
        })

        const tool = tools.get("list_organizations")!
        const result = await tool.execute({})

        expect(result).toContain("Test Org")
        expect(result).toContain("org-123")
        expect(result).toContain("(default)")
      })

      it("handles empty organizations list", async () => {
        mockZohoListOrganizations.mockResolvedValue({
          ok: true,
          data: { organizations: [] },
        })

        const tool = tools.get("list_organizations")!
        const result = await tool.execute({})

        expect(result).toContain("No organizations found")
      })

      it("handles API error", async () => {
        mockZohoListOrganizations.mockResolvedValue({
          ok: false,
          errorMessage: "Authentication failed",
        })

        const tool = tools.get("list_organizations")!
        const result = await tool.execute({})

        expect(result).toBe("Authentication failed")
      })

      it("handles missing error message", async () => {
        mockZohoListOrganizations.mockResolvedValue({
          ok: false,
        })

        const tool = tools.get("list_organizations")!
        const result = await tool.execute({})

        expect(result).toBe("Failed to list organizations")
      })
    })

    describe("get_organization", () => {
      it("gets organization details successfully", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {
            organization: {
              organization_id: "org-123",
              name: "Test Org",
              is_default_org: false,
              currency_code: "EUR",
              currency_symbol: "€",
              time_zone: "Europe/Berlin",
              language_code: "en",
              fiscal_year_start_month: 4,
              account_created_date: "2024-01-01",
            },
          },
        })

        const tool = tools.get("get_organization")!
        const result = await tool.execute({ organization_id: "org-123" })

        expect(result).toContain("Test Org")
        expect(result).toContain("EUR")
        expect(result).toContain("Europe/Berlin")
      })

      it("handles organization not found", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {},
        })

        const tool = tools.get("get_organization")!
        const result = await tool.execute({ organization_id: "org-123" })

        expect(result).toBe("Organization not found")
      })

      it("handles API error", async () => {
        mockZohoGet.mockResolvedValue({
          ok: false,
          errorMessage: "Not authorized",
        })

        const tool = tools.get("get_organization")!
        const result = await tool.execute({ organization_id: "org-123" })

        expect(result).toBe("Not authorized")
      })
    })
  })

  describe("Contact Tools", () => {
    beforeEach(() => {
      registerContactTools(server)
    })

    describe("list_contacts", () => {
      it("lists contacts successfully", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {
            contacts: [
              {
                contact_id: "contact-123",
                contact_name: "John Doe",
                contact_type: "customer",
                company_name: "Acme Inc",
                email: "john@acme.com",
                phone: "555-1234",
                status: "active",
              },
            ],
          },
        })

        const tool = tools.get("list_contacts")!
        const result = await tool.execute({})

        expect(result).toContain("John Doe")
        expect(result).toContain("contact-123")
        expect(result).toContain("customer")
      })

      it("handles empty contacts list", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: { contacts: [] },
        })

        const tool = tools.get("list_contacts")!
        const result = await tool.execute({})

        expect(result).toBe("No contacts found.")
      })

      it("handles API error", async () => {
        mockZohoGet.mockResolvedValue({
          ok: false,
          errorMessage: "Rate limit exceeded",
        })

        const tool = tools.get("list_contacts")!
        const result = await tool.execute({})

        expect(result).toBe("Rate limit exceeded")
      })

      it("passes query parameters correctly", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: { contacts: [] },
        })

        const tool = tools.get("list_contacts")!
        await tool.execute({
          contact_type: "vendor",
          status: "active",
          search_text: "test",
          sort_column: "contact_name",
          page: 2,
          per_page: 50,
        })

        expect(mockZohoGet).toHaveBeenCalledWith(
          "/contacts",
          undefined,
          expect.objectContaining({
            contact_type: "vendor",
            status: "active",
            search_text: "test",
            sort_column: "contact_name",
            page: "2",
            per_page: "50",
          })
        )
      })
    })

    describe("get_contact", () => {
      it("gets contact details successfully", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {
            contact: {
              contact_id: "contact-123",
              contact_name: "Jane Smith",
              contact_type: "vendor",
              company_name: "Smith Corp",
              email: "jane@smith.com",
              phone: "555-5678",
              status: "active",
              payment_terms: 30,
              currency_code: "USD",
            },
          },
        })

        const tool = tools.get("get_contact")!
        const result = await tool.execute({ contact_id: "contact-123" })

        expect(result).toContain("Jane Smith")
        expect(result).toContain("vendor")
        expect(result).toContain("30 days")
      })

      it("handles contact not found", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {},
        })

        const tool = tools.get("get_contact")!
        const result = await tool.execute({ contact_id: "contact-123" })

        expect(result).toBe("Contact not found")
      })
    })
  })

  describe("Chart of Accounts Tools", () => {
    beforeEach(() => {
      registerChartOfAccountsTools(server)
    })

    describe("list_accounts", () => {
      it("lists accounts successfully", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {
            chartofaccounts: [
              {
                account_id: "acc-123",
                account_name: "Cash",
                account_type_formatted: "Asset",
                account_code: "1000",
                is_active: true,
                current_balance: 5000,
              },
            ],
          },
        })

        const tool = tools.get("list_accounts")!
        const result = await tool.execute({})

        expect(result).toContain("Cash")
        expect(result).toContain("acc-123")
        expect(result).toContain("Asset")
      })

      it("handles empty accounts list", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: { chartofaccounts: [] },
        })

        const tool = tools.get("list_accounts")!
        const result = await tool.execute({})

        expect(result).toBe("No accounts found.")
      })
    })

    describe("get_account", () => {
      it("gets account details successfully", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {
            account: {
              account_id: "acc-123",
              account_name: "Operating Expenses",
              account_type_formatted: "Expense",
              account_code: "5000",
              is_active: true,
              is_user_created: true,
              current_balance: 2500,
              currency_code: "USD",
              parent_account_name: "Expenses",
              description: "General operating expenses",
            },
          },
        })

        const tool = tools.get("get_account")!
        const result = await tool.execute({ account_id: "acc-123" })

        expect(result).toContain("Operating Expenses")
        expect(result).toContain("Expense")
        expect(result).toContain("2500")
        expect(result).toContain("Expenses")
      })

      it("handles account not found", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {},
        })

        const tool = tools.get("get_account")!
        const result = await tool.execute({ account_id: "acc-123" })

        expect(result).toBe("Account not found")
      })
    })

    describe("create_account", () => {
      it("creates account successfully", async () => {
        mockZohoPost.mockResolvedValue({
          ok: true,
          data: {
            account: {
              account_id: "new-acc-456",
              account_name: "Marketing",
              account_type_formatted: "Expense",
              account_code: "6000",
            },
          },
        })

        const tool = tools.get("create_account")!
        const result = await tool.execute({
          account_name: "Marketing",
          account_type: "expense",
          account_code: "6000",
        })

        expect(result).toContain("Account Created Successfully")
        expect(result).toContain("Marketing")
        expect(result).toContain("new-acc-456")
      })

      it("handles creation failure", async () => {
        mockZohoPost.mockResolvedValue({
          ok: false,
          errorMessage: "Account name already exists",
        })

        const tool = tools.get("create_account")!
        const result = await tool.execute({
          account_name: "Marketing",
          account_type: "expense",
        })

        expect(result).toBe("Account name already exists")
      })

      it("handles missing account in response", async () => {
        mockZohoPost.mockResolvedValue({
          ok: true,
          data: {},
        })

        const tool = tools.get("create_account")!
        const result = await tool.execute({
          account_name: "Marketing",
          account_type: "expense",
        })

        expect(result).toBe("Account created but no details returned")
      })
    })

    describe("list_account_transactions", () => {
      it("lists transactions successfully", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: {
            transactions: [
              {
                transaction_date: "2024-01-15",
                transaction_type_formatted: "Journal",
                debit_or_credit: "debit",
                debit_amount: 100,
                credit_amount: 0,
                description: "Office supplies",
                offset_account_name: "Cash",
              },
            ],
          },
        })

        const tool = tools.get("list_account_transactions")!
        const result = await tool.execute({ account_id: "acc-123" })

        expect(result).toContain("2024-01-15")
        expect(result).toContain("Journal")
        expect(result).toContain("Debit: 100")
      })

      it("handles empty transactions", async () => {
        mockZohoGet.mockResolvedValue({
          ok: true,
          data: { transactions: [] },
        })

        const tool = tools.get("list_account_transactions")!
        const result = await tool.execute({ account_id: "acc-123" })

        expect(result).toBe("No transactions found for this account.")
      })
    })
  })
})
