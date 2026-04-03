# ─── Zoho Bookkeeper MCP Server ──────────────────────────────────────────────
# Multi-stage build: build stage compiles TypeScript, runtime stage is lean.
# Uses npm (not pnpm) to avoid lockfile version mismatch issues on Railway.

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy lockfiles first for layer caching
COPY package.json package-lock.json ./

# npm ci is deterministic, fast, and fails if package-lock.json is out of sync
RUN npm ci --ignore-scripts

# Copy source
COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Security: run as non-root user
RUN addgroup -S mcp && adduser -S mcp -G mcp

# Copy only what runtime needs
COPY package.json package-lock.json ./

# Production deps only
RUN npm ci --omit=dev --ignore-scripts && \
    # Clean npm cache to reduce image size
    npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Switch to non-root
USER mcp

# Expose HTTP port
EXPOSE 8004

# Environment defaults (overridden by Railway env vars)
ENV PORT=8004
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Health check — Railway uses this to determine if the container is healthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-8004}/health || exit 1

# Entry point
CMD ["node", "dist/server.js"]
