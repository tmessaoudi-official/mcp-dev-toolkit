FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production image ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

LABEL org.opencontainers.image.title="mcp-dev-toolkit"
LABEL org.opencontainers.image.description="MCP server with developer superpowers"
LABEL org.opencontainers.image.licenses="MIT"

# Install runtime tools needed by tools (git, docker CLI)
RUN apk add --no-cache git docker-cli

WORKDIR /app

# Copy only the built output and production manifest
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

RUN npm ci --omit=dev --ignore-scripts

# The server communicates over stdio — no port to expose
# Mount the host docker socket to enable docker_compose_status tool
# Mount the codebase you want to inspect

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
