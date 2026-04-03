# Zoho Bookkeeper MCP Server
# Node 22 required: fastmcp transitive dep (pipenet) requires node>=22.

FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/
RUN npm run build

ENV HOST=0.0.0.0
ENV NODE_ENV=production
# PORT is NOT set here — Railway injects it via Variables tab
# Set PORT=8080 explicitly in Railway Variables tab

CMD ["node", "dist/server.js"]
