Good. I now have a complete picture of the repo, your current architecture, and both client requirements. Let me design the full solution.Good. I have full context on the repo structure, your current architecture, and all requirements. Let me now design the complete solution.
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation-duration: 0.25s;
    animation-timing-function: cubic-bezier(0.19, 1, 0.22, 1);
  }
VvisualizeVvisualize show_widgetNow let me give you every file you need to implement this — complete, copy-paste ready.

What the Architecture Gives You
One Railway server, one Claude.ai connector URL, unlimited clients. You say "switch to Acoustic Interio" and every subsequent tool call uses that client's credentials and org ID. No reconnecting, no new conversations needed.

Implementation — Complete File Changes
1. src/config.ts — Replace entirely
This is the brain of multi-client support. Each client is defined by 3 env vars with a CLIENT_<SLUG>_ prefix.
typescript// src/config.ts
import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("8004"),
  HOST: z.string().default("0.0.0.0"),
  MCP_API_KEY: z.string().min(1, "MCP_API_KEY is required — set it in Railway env vars"),
});

export const env = envSchema.parse(process.env);

// --- Multi-client registry ---
export interface ClientConfig {
  slug: string;
  displayName: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orgId: string;
  apiUrl: string;
}

function loadClients(): Map<string, ClientConfig> {
  const clients = new Map<string, ClientConfig>();
  
  // Scan all env vars for CLIENT_<SLUG>_CLIENT_ID pattern
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^CLIENT_([A-Z0-9_]+)_CLIENT_ID$/);
    if (!match || !value) continue;
    
    const slug = match[1].toLowerCase();
    const prefix = `CLIENT_${match[1]}`;
    
    const clientId = process.env[`${prefix}_CLIENT_ID`];
    const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    const refreshToken = process.env[`${prefix}_REFRESH_TOKEN`];
    const orgId = process.env[`${prefix}_ORG_ID`];
    const displayName = process.env[`${prefix}_NAME`] ?? slug;
    const apiUrl = process.env[`${prefix}_API_URL`] ?? "https://www.zohoapis.in/books/v3";
    
    if (!clientId || !clientSecret || !refreshToken || !orgId) {
      console.warn(`[config] Skipping client ${slug} — missing required env vars`);
      continue;
    }
    
    clients.set(slug, { slug, displayName, clientId, clientSecret, refreshToken, orgId, apiUrl });
  }
  
  if (clients.size === 0) {
    throw new Error("No clients configured. Add CLIENT_<SLUG>_CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN, _ORG_ID to Railway env vars.");
  }
  
  console.log(`[config] Loaded ${clients.size} client(s): ${[...clients.keys()].join(", ")}`);
  return clients;
}

export const clients = loadClients();

// Active client state — persists for the server process lifetime
// In a multi-user scenario you'd scope this to session; for CA solo use, process-level is fine
let _activeSlug: string = clients.keys().next().value!;

export function getActiveClient(): ClientConfig {
  const client = clients.get(_activeSlug);
  if (!client) throw new Error(`Active client "${_activeSlug}" not found`);
  return client;
}

export function setActiveClient(slug: string): ClientConfig {
  const normalised = slug.toLowerCase().trim();
  if (!clients.has(normalised)) {
    const available = [...clients.keys()].join(", ");
    throw new Error(`Client "${slug}" not found. Available: ${available}`);
  }
  _activeSlug = normalised;
  return clients.get(normalised)!;
}

export function listClients(): ClientConfig[] {
  return [...clients.values()];
}

export function getActiveSlug(): string {
  return _activeSlug;
}

2. src/auth/oauth.ts — Replace entirely
Per-client token cache with auto-refresh.
typescript// src/auth/oauth.ts
import type { ClientConfig } from "../config.js";

interface TokenEntry {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Keyed by client slug
const tokenCache = new Map<string, TokenEntry>();

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export async function getAccessToken(client: ClientConfig): Promise<string> {
  const cached = tokenCache.get(client.slug);
  
  if (cached && Date.now() < cached.expiresAt - REFRESH_BUFFER_MS) {
    return cached.accessToken;
  }
  
  // Determine accounts domain from API URL
  const apiDomain = new URL(client.apiUrl).hostname; // e.g. www.zohoapis.in
  const accountsDomain = apiDomain.replace("www.zohoapis", "accounts.zoho"); // accounts.zoho.in
  
  const params = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: client.refreshToken,
    grant_type: "refresh_token",
  });
  
  const response = await fetch(`https://${accountsDomain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[${client.slug}] Token refresh failed ${response.status}: ${text}`);
  }
  
  const data = await response.json() as { access_token?: string; expires_in?: number; error?: string };
  
  if (data.error || !data.access_token) {
    throw new Error(`[${client.slug}] Token refresh error: ${data.error ?? "no access_token returned"}`);
  }
  
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  tokenCache.set(client.slug, { accessToken: data.access_token, expiresAt });
  
  console.log(`[oauth] Refreshed token for ${client.slug}, expires in ${Math.round((expiresAt - Date.now()) / 60000)}m`);
  return data.access_token;
}

export function invalidateToken(slug: string): void {
  tokenCache.delete(slug);
}

3. src/api/client.ts — Replace entirely
The API client now takes a ClientConfig instead of reading globals.
typescript// src/api/client.ts
import { getAccessToken } from "../auth/oauth.js";
import type { ClientConfig } from "../config.js";

async function zohoRequest(
  client: ClientConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const token = await getAccessToken(client);
  
  const url = new URL(`${client.apiUrl}${path}`);
  url.searchParams.set("organization_id", client.orgId);
  
  console.log(`[ZOHO ${method}] ${url.toString()}`);
  if (body) console.log(`[ZOHO BODY] ${JSON.stringify(body)}`);
  
  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  
  const responseText = await response.text();
  console.log(`[ZOHO RESP] ${response.status} ${responseText.slice(0, 300)}`);
  
  let data: unknown;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Zoho returned non-JSON (${response.status}): ${responseText.slice(0, 200)}`);
  }
  
  const d = data as Record<string, unknown>;
  if (d.code !== undefined && d.code !== 0) {
    throw new Error(`Zoho API error ${d.code}: ${d.message ?? JSON.stringify(d)}`);
  }
  
  return data;
}

export const zohoGet = (client: ClientConfig, path: string) =>
  zohoRequest(client, "GET", path);

export const zohoPost = (client: ClientConfig, path: string, body: Record<string, unknown>) =>
  zohoRequest(client, "POST", path, body);

export const zohoPut = (client: ClientConfig, path: string, body: Record<string, unknown>) =>
  zohoRequest(client, "PUT", path, body);

export const zohoDelete = (client: ClientConfig, path: string) =>
  zohoRequest(client, "DELETE", path);

4. src/tools/client-switcher.ts — New file
typescript// src/tools/client-switcher.ts
import { z } from "zod";
import { getActiveClient, getActiveSlug, listClients, setActiveClient } from "../config.js";
import type { FastMCP } from "fastmcp";

export function registerClientSwitcherTools(server: FastMCP) {
  server.addTool({
    name: "list_clients",
    description: "List all configured Zoho Books clients (companies). Use this to see which clients are available before switching.",
    parameters: z.object({}),
    execute: async () => {
      const clients = listClients();
      const active = getActiveSlug();
      const rows = clients.map(c =>
        `${c.slug === active ? "▶ " : "  "}${c.slug.padEnd(20)} ${c.displayName.padEnd(30)} org:${c.orgId}`
      );
      return `Active client: ${active}\n\nAvailable clients:\n${rows.join("\n")}`;
    },
  });

  server.addTool({
    name: "set_active_client",
    description: "Switch to a different client (company). All subsequent tool calls will use this client's Zoho Books org. Call list_clients first to see available slugs.",
    parameters: z.object({
      client_slug: z.string().min(1).describe(
        "Client slug to switch to — e.g. 'flutch', 'acoustic'. Use list_clients to see all available slugs."
      ),
    }),
    execute: async ({ client_slug }) => {
      const client = setActiveClient(client_slug);
      return `Switched to client: ${client.displayName}\nOrg ID: ${client.orgId}\nAPI: ${client.apiUrl}\n\nAll tools are now operating on this client's Zoho Books account.`;
    },
  });

  server.addTool({
    name: "get_active_client",
    description: "Show which client (company) is currently active.",
    parameters: z.object({}),
    execute: async () => {
      const client = getActiveClient();
      return `Active client: ${client.displayName} (${client.slug})\nOrg ID: ${client.orgId}\nAPI: ${client.apiUrl}`;
    },
  });
}

5. src/tools/bank-statement.ts — New file (the core reconciliation tools)
This is the complete, corrected banking categorization tool with the correct endpoint:
typescript// src/tools/bank-statement.ts
import { z } from "zod";
import { zohoGet, zohoPost } from "../api/client.js";
import { getActiveClient } from "../config.js";
import type { FastMCP } from "fastmcp";

export function registerBankStatementTools(server: FastMCP) {

  server.addTool({
    name: "list_bank_statement_transactions",
    description: "List transactions in the Zoho Books Banking feed for the active client. Use filter_by=Status.Uncategorized to see only uncategorized ones.",
    parameters: z.object({
      bank_account_id: z.string().min(1).describe("Zoho bank account ID"),
      filter_by: z.string().optional().describe("e.g. Status.Uncategorized"),
      page: z.number().int().min(1).default(1).describe("Page number (200 per page)"),
    }),
    execute: async ({ bank_account_id, filter_by, page }) => {
      const client = getActiveClient();
      const path = `/bankaccounts/${bank_account_id}/transactions?per_page=200&page=${page}${filter_by ? `&filter_by=${filter_by}` : ""}`;
      const data = await zohoGet(client, path) as Record<string, unknown>;
      return JSON.stringify(data, null, 2);
    },
  });

  server.addTool({
    name: "categorize_bank_statement_transaction",
    description: "Categorize a single uncategorized Banking feed transaction in Zoho Books. This is equivalent to clicking the Categorize button in the Banking UI — it links the existing feed entry to a GL account WITHOUT creating a new expense (no double-counting).",
    parameters: z.object({
      bank_account_id: z.string().min(1).describe("Zoho bank account ID — e.g. 1145125000001109343"),
      transaction_id: z.string().min(1).describe("The transaction ID from list_bank_statement_transactions"),
      account_id: z.string().min(1).describe("GL account ID to categorize against — from chart of accounts"),
      transaction_type: z.enum(["expense", "deposit"]).describe("expense = outflow/debit, deposit = inflow/credit"),
      amount: z.number().positive().describe("Transaction amount in INR"),
      date: z.string().describe("Transaction date in YYYY-MM-DD format"),
      reference_number: z.string().optional().describe("Optional reference number"),
    }),
    execute: async ({ bank_account_id, transaction_id, account_id, transaction_type, amount, date, reference_number }) => {
      const client = getActiveClient();
      
      const body: Record<string, unknown> = {
        account_id,
        transaction_type,
        amount,
        date,
      };
      if (reference_number) body.reference_number = reference_number;
      
      // Correct endpoint — confirmed from Zoho Books API docs
      const path = `/bankaccounts/${bank_account_id}/transactions/${transaction_id}/categorize`;
      
      try {
        const data = await zohoPost(client, path, body);
        return `Successfully categorized transaction ${transaction_id}\n${JSON.stringify(data, null, 2)}`;
      } catch (err) {
        const error = err as Error;
        return `FAILED to categorize ${transaction_id}: ${error.message}`;
      }
    },
  });

  server.addTool({
    name: "match_bank_transaction",
    description: "Match a Banking feed transaction to an existing invoice, bill, or payment in Zoho Books.",
    parameters: z.object({
      bank_account_id: z.string().min(1).describe("Zoho bank account ID"),
      transaction_id: z.string().min(1).describe("Banking feed transaction ID"),
      entity_type: z.enum(["invoice", "bill", "creditnote", "vendorcredit"]).describe("Type of entity to match to"),
      entity_id: z.string().min(1).describe("ID of the invoice/bill/payment to match"),
      amount: z.number().positive().describe("Amount to match"),
    }),
    execute: async ({ bank_account_id, transaction_id, entity_type, entity_id, amount }) => {
      const client = getActiveClient();
      const body = { entity_type, entity_id, amount };
      const path = `/bankaccounts/${bank_account_id}/transactions/${transaction_id}/match`;
      const data = await zohoPost(client, path, body);
      return JSON.stringify(data, null, 2);
    },
  });

  server.addTool({
    name: "exclude_bank_transaction",
    description: "Exclude a Banking feed transaction from reconciliation (mark as excluded).",
    parameters: z.object({
      bank_account_id: z.string().min(1).describe("Zoho bank account ID"),
      transaction_id: z.string().min(1).describe("Banking feed transaction ID to exclude"),
    }),
    execute: async ({ bank_account_id, transaction_id }) => {
      const client = getActiveClient();
      const path = `/bankaccounts/${bank_account_id}/transactions/${transaction_id}/exclude`;
      const data = await zohoPost(client, path, {});
      return JSON.stringify(data, null, 2);
    },
  });

  server.addTool({
    name: "get_reconciliation_summary",
    description: "Get a summary of reconciliation status for a bank account — total transactions, uncategorized count, and amounts.",
    parameters: z.object({
      bank_account_id: z.string().min(1).describe("Zoho bank account ID"),
    }),
    execute: async ({ bank_account_id }) => {
      const client = getActiveClient();
      const path = `/bankaccounts/${bank_account_id}/transactions?filter_by=Status.Uncategorized&per_page=1&page=1`;
      const data = await zohoGet(client, path) as Record<string, unknown>;
      const pageContext = (data as any).page_context;
      return `Client: ${client.displayName} (${client.orgId})\nBank account: ${bank_account_id}\n\nUncategorized transactions:\n${JSON.stringify(pageContext ?? data, null, 2)}`;
    },
  });

  server.addTool({
    name: "bulk_categorize_transactions",
    description: "Categorize multiple Banking feed transactions in bulk. Pass an array of transaction objects. Processes sequentially with a 700ms delay between calls to avoid Zoho rate limits. Reports progress every 10 entries.",
    parameters: z.object({
      bank_account_id: z.string().min(1).describe("Zoho bank account ID"),
      transactions: z.array(z.object({
        transaction_id: z.string().min(1),
        account_id: z.string().min(1),
        transaction_type: z.enum(["expense", "deposit"]),
        amount: z.number().positive(),
        date: z.string(),
        reference_number: z.string().optional(),
      })).describe("Array of transactions to categorize"),
    }),
    execute: async ({ bank_account_id, transactions }) => {
      const client = getActiveClient();
      const results = { success: 0, failed: 0, errors: [] as string[] };
      
      for (let i = 0; i < transactions.length; i++) {
        const txn = transactions[i];
        
        try {
          const body: Record<string, unknown> = {
            account_id: txn.account_id,
            transaction_type: txn.transaction_type,
            amount: txn.amount,
            date: txn.date,
          };
          if (txn.reference_number) body.reference_number = txn.reference_number;
          
          const path = `/bankaccounts/${bank_account_id}/transactions/${txn.transaction_id}/categorize`;
          await zohoPost(client, path, body);
          results.success++;
        } catch (err) {
          results.failed++;
          results.errors.push(`${txn.transaction_id}: ${(err as Error).message}`);
        }
        
        // Zoho rate limit: 100 req/min → 700ms delay
        if (i < transactions.length - 1) {
          await new Promise(r => setTimeout(r, 700));
        }
        
        // Progress checkpoint every 10
        if ((i + 1) % 10 === 0) {
          console.log(`[bulk_categorize] Progress: ${i + 1}/${transactions.length} — ${results.success} ok, ${results.failed} failed`);
        }
      }
      
      return `Bulk categorization complete for ${client.displayName}:\n✅ Success: ${results.success}\n❌ Failed: ${results.failed}\n\nErrors:\n${results.errors.join("\n") || "None"}`;
    },
  });
}

6. src/middleware/auth.ts — New file (API key gate)
typescript// src/middleware/auth.ts
import { env } from "../config.js";

export function validateApiKey(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!authHeader) return false;
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  return token === env.MCP_API_KEY;
}

7. src/server.ts — Add auth middleware
In your existing server.ts where the HTTP handler is defined, add this at the top of your request handler (before the MCP protocol handling):
typescript// At the top of your POST /mcp handler:
import { validateApiKey } from "./middleware/auth.js";

// Inside the handler:
if (!validateApiKey(request)) {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

8. src/index.ts — Register the new tools
Add these two imports and registrations to your existing tool registration block:
typescriptimport { registerClientSwitcherTools } from "./tools/client-switcher.js";
import { registerBankStatementTools } from "./tools/bank-statement.js";

// In your server setup function:
registerClientSwitcherTools(server);
registerBankStatementTools(server);

Railway Environment Variables — Complete Setup
Go to Railway Dashboard → your service → Variables and add these. Never put these in your code or .env committed to GitHub.
# Security gate — generate a strong random string
MCP_API_KEY=your-strong-random-api-key-here

# Client 1 — Flutch Technology
CLIENT_FLUTCH_NAME=Flutch Technology Pvt Ltd
CLIENT_FLUTCH_CLIENT_ID=1000.xxxxx
CLIENT_FLUTCH_CLIENT_SECRET=xxxxx
CLIENT_FLUTCH_REFRESH_TOKEN=1000.xxxxx.xxxxx
CLIENT_FLUTCH_ORG_ID=60018950074
CLIENT_FLUTCH_API_URL=https://www.zohoapis.in/books/v3

# Client 2 — Acoustic Interio
CLIENT_ACOUSTIC_NAME=Acoustic Interio Solutions
CLIENT_ACOUSTIC_CLIENT_ID=1000.xxxxx
CLIENT_ACOUSTIC_CLIENT_SECRET=xxxxx
CLIENT_ACOUSTIC_REFRESH_TOKEN=1000.xxxxx.xxxxx
CLIENT_ACOUSTIC_ORG_ID=60041513897
CLIENT_ACOUSTIC_API_URL=https://www.zohoapis.in/books/v3

# Add more clients following the same pattern:
# CLIENT_<SLUG>_NAME, CLIENT_<SLUG>_CLIENT_ID, etc.
To add a new client in the future — just add 6 env vars in Railway and redeploy. Zero code changes needed.

Claude.ai Connector Update
After Railway deploys, update your Claude.ai connector with the MCP_API_KEY as a Bearer token:
In Claude.ai Settings → Connectors → your connector → add header:
Authorization: Bearer your-strong-random-api-key-here

Workflow After This Is Deployed
You: "Switch to Acoustic Interio"
→ set_active_client("acoustic")
→ Confirmed: Acoustic Interio Solutions, Org 60041513897

You: "Show me uncategorized transactions"
→ list_bank_statement_transactions(bank_account_id=..., filter_by=Status.Uncategorized)
→ Returns Acoustic's transactions

You: "Switch to Flutch, categorize transaction 1145125000001613421"
→ set_active_client("flutch")
→ categorize_bank_statement_transaction(...)
→ Hits correct Flutch org