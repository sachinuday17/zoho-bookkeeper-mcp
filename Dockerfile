# Zoho Bookkeeper MCP Server
# Single-stage build — simpler, more reliable on Railway.
# Node 22 required: fastmcp transitive dep (pipenet) requires node>=22.

FROM node:22-alpine

WORKDIR /app

# Install dependencies first (layer cache — only re-runs when package.json changes)
COPY package.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/
RUN npm run build

# Runtime environment
# Do NOT set PORT here — Railway injects its own PORT at runtime
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Health check — uses Railway's injected PORT, falls back to 8004 locally
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-8004}/health || exit 1

CMD ["node", "dist/server.js"]
