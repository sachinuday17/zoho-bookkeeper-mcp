# ─── Zoho Bookkeeper MCP Server ──────────────────────────────────────────────
# Multi-stage build — builder compiles TS, runtime is lean production image.
# Node 22 required: pipenet (fastmcp dep) requires node>=22.
# Uses npm install (not npm ci) — avoids lockfile version sync issues.

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifest only — install before copying source for layer caching
COPY package.json ./

# Full install (dev + prod) so TypeScript compiler and tsup are available
RUN npm install --ignore-scripts

# Copy source
COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Security: run as non-root
RUN addgroup -S mcp && adduser -S mcp -G mcp

# Copy only package manifest — install production deps fresh
COPY package.json ./

RUN npm install --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

USER mcp

EXPOSE 8004

ENV PORT=8004
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Generous start period — npm install needs time on first boot
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-8004}/health || exit 1

CMD ["node", "dist/server.js"]
