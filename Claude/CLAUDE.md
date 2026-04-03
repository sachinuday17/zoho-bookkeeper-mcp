# Zoho Bookkeeper MCP Server

Custom MCP server for Zoho Books integration, designed for bookkeeping workflows.

## Why This Exists

The official Zoho MCP service (zohomcp.com) has limitations:
- **Cannot upload file attachments** - The MCP schema incorrectly maps binary file parameters as query strings
- **Too many tools** - 100+ tools cause Anthropic rate limit issues (30k tokens/min)
- **No control over tool selection** - Can't curate which tools are exposed

This custom MCP server provides:
- Proper multipart/form-data file uploads for attachments
- Curated set of tools for bookkeeping workflows
- Auto-refreshing OAuth tokens
- Single server instead of splitting between Zoho MCP + document-loader

## Tech Stack

- **Runtime**: Node.js 20+ (Alpine for Docker)
- **Framework**: FastMCP (same as document-loader)
- **Language**: TypeScript
- **Auth**: OAuth 2.0 with refresh token flow

## Authentication

Uses Zoho OAuth 2.0 with auto-refresh:

```
ZOHO_CLIENT_ID=1000.xxx
ZOHO_CLIENT_SECRET=xxx
ZOHO_REFRESH_TOKEN=1000.xxx
```

Access tokens are refreshed automatically when they expire (1 hour lifetime).

## API Reference

Base URL: `https://www.zohoapis.com/books/v3`

All endpoints require:
- Header: `Authorization: Zoho-oauthtoken {access_token}`
- Query param: `organization_id={org_id}`

## Tools to Implement

### Organization
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `get_organization` | GET | `/organizations/{org_id}` | Get org details |
| `list_organizations` | GET | `/organizations` | List all orgs |

### Chart of Accounts
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `list_accounts` | GET | `/chartofaccounts` | List all accounts |
| `get_account` | GET | `/chartofaccounts/{account_id}` | Get account details |
| `create_account` | POST | `/chartofaccounts` | Create new account |
| `list_account_transactions` | GET | `/chartofaccounts/transactions` | Get transactions for account |

### Journals
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `list_journals` | GET | `/journals` | List all journals |
| `get_journal` | GET | `/journals/{journal_id}` | Get journal details |
| `create_journal` | POST | `/journals` | Create journal entry |
| `update_journal` | PUT | `/journals/{journal_id}` | Update journal |
| `delete_journal` | DELETE | `/journals/{journal_id}` | Delete journal |
| `publish_journal` | POST | `/journals/{journal_id}/status/publish` | Mark as published |

### Journal Attachments (multipart/form-data)
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `add_journal_attachment` | POST | `/journals/{journal_id}/attachment` | Upload file |
| `get_journal_attachment` | GET | `/journals/{journal_id}/attachment` | Get attachment info |
| `delete_journal_attachment` | DELETE | `/journals/{journal_id}/attachment` | Remove attachment |

### Bank Accounts
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `list_bank_accounts` | GET | `/bankaccounts` | List bank accounts |
| `get_bank_account` | GET | `/bankaccounts/{account_id}` | Get bank account |
| `list_bank_transactions` | GET | `/banktransactions` | List transactions |

### Expenses
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `list_expenses` | GET | `/expenses` | List expenses |
| `get_expense` | GET | `/expenses/{expense_id}` | Get expense details |
| `create_expense` | POST | `/expenses` | Create expense |
| `add_expense_attachment` | POST | `/expenses/{expense_id}/attachment` | Upload receipt |
| `get_expense_attachment` | GET | `/expenses/{expense_id}/attachment` | Get attachment |
| `delete_expense_attachment` | DELETE | `/expenses/{expense_id}/attachment` | Remove attachment |

### Bills
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `list_bills` | GET | `/bills` | List bills |
| `get_bill` | GET | `/bills/{bill_id}` | Get bill details |
| `create_bill` | POST | `/bills` | Create bill |
| `add_bill_attachment` | POST | `/bills/{bill_id}/attachment` | Upload file |
| `get_bill_attachment` | GET | `/bills/{bill_id}/attachment` | Get attachment |
| `delete_bill_attachment` | DELETE | `/bills/{bill_id}/attachment` | Remove attachment |

### Invoices
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `list_invoices` | GET | `/invoices` | List invoices |
| `get_invoice` | GET | `/invoices/{invoice_id}` | Get invoice details |
| `add_invoice_attachment` | POST | `/invoices/{invoice_id}/attachment` | Upload file |
| `get_invoice_attachment` | GET | `/invoices/{invoice_id}/attachment` | Get attachment |
| `delete_invoice_attachment` | DELETE | `/invoices/{invoice_id}/attachment` | Remove attachment |

### Contacts
| Tool | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| `list_contacts` | GET | `/contacts` | List contacts/vendors |
| `get_contact` | GET | `/contacts/{contact_id}` | Get contact details |

## File Structure

```
zoho-bookkeeper-mcp/
├── CLAUDE.md           # This file
├── package.json        # Dependencies
├── tsconfig.json       # TypeScript config
├── Dockerfile          # Container build
├── src/
│   ├── index.ts        # Main MCP server with tools
│   └── server.ts       # HTTP server entry point
```

**Note**: Keep it simple - single index.ts file with all tools is fine. The document-loader MCP uses this pattern successfully.

## Implementation Notes

### OAuth Token Refresh

```typescript
let accessToken = ""
let tokenExpiry = 0

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken
  }

  const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  })

  const data = await response.json()
  accessToken = data.access_token
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000 // 5 min buffer
  return accessToken
}
```

### Multipart File Upload (Working Pattern from document-loader)

This is the working implementation for multipart/form-data file uploads:

```typescript
import * as fs from "fs"
import * as path from "path"

// MIME type helper
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }
  return mimeTypes[ext] || "application/octet-stream"
}

// Response parser
async function parseZohoResponse(response: Response): Promise<{ ok: boolean; data: any; error?: string }> {
  const responseText = await response.text()
  let data: any
  try {
    data = JSON.parse(responseText)
  } catch {
    data = { raw: responseText }
  }

  if (!response.ok) {
    return {
      ok: false,
      data,
      error: `HTTP ${response.status}: ${response.statusText}\n${JSON.stringify(data, null, 2)}`,
    }
  }

  if (data.code !== undefined && data.code !== 0) {
    return {
      ok: false,
      data,
      error: `Zoho error ${data.code}: ${data.message || "Unknown error"}`,
    }
  }

  return { ok: true, data }
}

// Upload function
async function addZohoAttachment(
  category: "bill" | "expense" | "invoice" | "journal",
  entityId: string,
  filePath: string,
  organizationId: string
): Promise<string> {
  const accessToken = await getAccessToken()

  if (!fs.existsSync(filePath)) {
    return `Error: File not found at ${filePath}`
  }

  const categoryPlural: Record<string, string> = {
    bill: "bills",
    expense: "expenses",
    invoice: "invoices",
    journal: "journals",
  }

  const fileBuffer = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)
  const mimeType = getMimeType(filePath)

  const formData = new FormData()
  const blob = new Blob([fileBuffer], { type: mimeType })
  formData.append("attachment", blob, fileName)

  const url = `${ZOHO_BOOKS_API_URL}/${categoryPlural[category]}/${entityId}/attachment?organization_id=${organizationId}`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      // DO NOT set Content-Type header - let fetch set it with boundary
    },
    body: formData,
  })

  const result = await parseZohoResponse(response)
  if (!result.ok) {
    return `Error adding attachment to ${category}: ${result.error}`
  }

  return `Attachment added successfully to ${category} ${entityId}`
}
```

**Important**: Do NOT set the `Content-Type` header manually when using FormData. Let `fetch` set it automatically with the correct multipart boundary.

### Tool Parameter Pattern

All tools should follow this pattern for organization_id:

```typescript
parameters: z.object({
  organization_id: z.string().describe("Zoho organization ID"),
  // ... other params
})
```

The agent gets the organization_id once via `get_organization` or `list_organizations` and reuses it.

## Complete Template Files

### package.json

```json
{
  "name": "zoho-bookkeeper-mcp",
  "version": "1.0.0",
  "description": "MCP server for Zoho Books integration with proper file upload support",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "serve": "node dist/server.js",
    "dev": "tsx watch src/server.ts"
  },
  "dependencies": {
    "fastmcp": "^3.13.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "tsx": "^4.19.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Dockerfile

```dockerfile
# Zoho Bookkeeper MCP Server
# Provides Zoho Books API integration with proper multipart file uploads

FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose HTTP port
EXPOSE 8004

# Set default environment
ENV PORT=8004
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8004/health || exit 1

# Run the HTTP server
CMD ["node", "dist/server.js"]
```

### src/server.ts

```typescript
import server from "./index.js"

const port = process.env.PORT ? parseInt(process.env.PORT) : 8004
const host = process.env.HOST || "0.0.0.0"

server.start({
  transportType: "httpStream",
  httpStream: {
    port: port,
    host: host,
  },
})

console.log(`📚 Zoho Bookkeeper MCP Server running on http://${host}:${port}`)
console.log(`📋 Health check: http://${host}:${port}/health`)
console.log(`🔍 MCP endpoint: http://${host}:${port}/mcp`)
```

### src/index.ts (skeleton)

```typescript
import { FastMCP } from "fastmcp"
import { z } from "zod"

// ============================================================================
// Configuration
// ============================================================================
const ZOHO_BOOKS_API_URL = process.env.ZOHO_API_URL || "https://www.zohoapis.com/books/v3"
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || ""
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || ""
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || ""

let accessToken = ""
let tokenExpiry = 0

// ============================================================================
// OAuth Token Management
// ============================================================================
async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken
  }

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error("Missing Zoho OAuth credentials")
  }

  const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to refresh token: ${errorText}`)
  }

  const data = await response.json()
  accessToken = data.access_token
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000 // 5 min buffer
  console.log("Zoho access token refreshed successfully")
  return accessToken
}

// ============================================================================
// API Helper
// ============================================================================
async function zohoRequest(
  method: string,
  endpoint: string,
  organizationId: string,
  body?: any
): Promise<any> {
  const token = await getAccessToken()
  const url = `${ZOHO_BOOKS_API_URL}${endpoint}?organization_id=${organizationId}`

  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
  }

  if (body && method !== "GET") {
    options.body = JSON.stringify(body)
  }

  const response = await fetch(url, options)
  const data = await response.json()

  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`Zoho API error ${data.code}: ${data.message}`)
  }

  return data
}

// ============================================================================
// Server Setup
// ============================================================================
const server = new FastMCP({
  name: "zoho-bookkeeper-mcp",
  version: "1.0.0",
  instructions: `
Zoho Books MCP server for bookkeeping workflows.
Provides curated tools for chart of accounts, journals, expenses, bills, and invoices.
All tools require organization_id - get it first using list_organizations or get_organization.
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

// ============================================================================
// Example Tool: List Organizations
// ============================================================================
server.addTool({
  name: "list_organizations",
  description: "List all Zoho organizations the user has access to. Use this to get organization_id for other tools.",
  parameters: z.object({}),
  annotations: {
    title: "List Organizations",
    readOnlyHint: true,
    openWorldHint: true,
  },
  execute: async () => {
    const token = await getAccessToken()
    const response = await fetch(`${ZOHO_BOOKS_API_URL}/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    })
    const data = await response.json()
    return JSON.stringify(data.organizations, null, 2)
  },
})

// ============================================================================
// Add more tools following this pattern...
// See "Tools to Implement" section for the full list
// ============================================================================

export default server
```

## Environment Variables

```bash
# Required
ZOHO_CLIENT_ID=1000.xxx
ZOHO_CLIENT_SECRET=xxx
ZOHO_REFRESH_TOKEN=1000.xxx

# Optional
ZOHO_API_URL=https://www.zohoapis.com/books/v3  # Default
PORT=8004  # Default
```

## Integration with LCOffice

### docker-compose.yml

```yaml
mcp-zoho-bookkeeper:
  build:
    context: ./mcp-servers/zoho-bookkeeper-mcp
  container_name: mcp-zoho-bookkeeper-${INSTANCE:-governance}
  restart: unless-stopped
  environment:
    PORT: 8004
    ZOHO_CLIENT_ID: ${ZOHO_CLIENT_ID}
    ZOHO_CLIENT_SECRET: ${ZOHO_CLIENT_SECRET}
    ZOHO_REFRESH_TOKEN: ${ZOHO_REFRESH_TOKEN}
  ports:
    - "8004:8004"
  networks:
    - librechat-network
```

### librechat.yaml

FastMCP uses `httpStream` transport which LibreChat connects to via `streamable-http`:

```yaml
mcpServers:
  zoho-bookkeeper:
    type: streamable-http
    url: http://mcp-zoho-bookkeeper:8004/mcp
    timeout: 30000
```

**Note**: The `/mcp` endpoint is automatically created by FastMCP when using httpStream transport.

### setup-agents.sh

Replace the Zoho MCP tools with:

```bash
BOOKKEEPER_TOOLS='[
  "sys__all__sys_mcp_mercury",
  "sys__all__sys_mcp_zoho-bookkeeper",
  "download_file_mcp_document-loader"
]'
```

## Migration Plan

### Step 1: Build zoho-bookkeeper-mcp
1. Create directory: `mkdir -p mcp-servers/zoho-bookkeeper-mcp/src`
2. Create all files (package.json, tsconfig.json, Dockerfile, src/index.ts, src/server.ts)
3. Implement all tools from the "Tools to Implement" section
4. Build: `docker compose -f docker-compose.yml -f docker-compose.dev.yml build mcp-zoho-bookkeeper`

### Step 2: Add to docker-compose.yml
```yaml
mcp-zoho-bookkeeper:
  build:
    context: ./mcp-servers/zoho-bookkeeper-mcp
  container_name: mcp-zoho-bookkeeper-${INSTANCE:-governance}
  restart: unless-stopped
  environment:
    PORT: 8004
    ZOHO_CLIENT_ID: ${ZOHO_CLIENT_ID}
    ZOHO_CLIENT_SECRET: ${ZOHO_CLIENT_SECRET}
    ZOHO_REFRESH_TOKEN: ${ZOHO_REFRESH_TOKEN}
  ports:
    - "8004:8004"
  networks:
    - librechat-network
  healthcheck:
    test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8004/health"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 30s
```

### Step 3: Add to configs/librechat.yaml
```yaml
mcpServers:
  zoho-bookkeeper:
    type: streamable-http
    url: http://mcp-zoho-bookkeeper:8004/mcp
    timeout: 30000
```

### Step 4: Update scripts/setup-agents.sh
Replace the Zoho MCP tools with:
```bash
BOOKKEEPER_TOOLS='[
  "sys__all__sys_mcp_mercury",
  "sys__all__sys_mcp_zoho-bookkeeper",
  "download_file_mcp_document-loader"
]'
```

### Step 5: Remove hosted Zoho MCP
- Remove `zoho-books` entry from librechat.yaml
- Remove `ZOHO_MCP_KEY` from .env and docker-compose.yml

### Step 6: Remove Zoho attachment tools from document-loader
After zoho-bookkeeper-mcp is working, remove these tools from document-loader:
- `zoho_add_attachment`
- `zoho_get_attachment`
- `zoho_delete_attachment`
- Related OAuth code and helpers

Keep document-loader for `download_file` only (Mercury S3 downloads).

### Step 7: Test
1. Start services: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`
2. Run setup-agents.sh to update Bookkeeper agent
3. Test in LibreChat UI:
   - Ask Bookkeeper to list organizations
   - Ask Bookkeeper to list chart of accounts
   - Ask Bookkeeper to create a journal entry with attachment

## Testing

```bash
# Build
docker compose -f docker-compose.yml -f docker-compose.dev.yml build mcp-zoho-bookkeeper

# Start
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d mcp-zoho-bookkeeper

# Test health
curl http://localhost:8004/health

# Test tools list
curl -X POST http://localhost:8004/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list","params":{}}'

# Watch logs
docker logs mcp-zoho-bookkeeper-librechat-tpj -f
```

## Current State (What Exists Now)

The `document-loader` MCP server currently has Zoho attachment tools that should be migrated:

**Existing tools in document-loader that will move to zoho-bookkeeper-mcp:**
- `zoho_add_attachment` - Add/upload attachment to bill/expense/invoice/journal
- `zoho_get_attachment` - Get attachment info from bill/expense/invoice/journal
- `zoho_delete_attachment` - Delete attachment from bill/expense/invoice/journal

**What document-loader will keep:**
- `download_file` - Download file from URL (Mercury S3) to watched directory

**Hosted Zoho MCP (zohomcp.com) limitations:**
- Cannot upload file attachments (schema incorrectly maps binary params as query strings)
- 100+ tools cause Anthropic rate limit issues (30k tokens/min)
- No control over which tools are exposed

This is why zoho-bookkeeper-mcp needs to be built - to provide proper multipart file uploads and a curated set of bookkeeping tools.
