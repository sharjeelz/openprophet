# ── Stage 1: Build Go binary ──────────────────────────────────────────
FROM golang:1.22-bullseye AS go-builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY config/ ./config/
COPY controllers/ ./controllers/
COPY database/ ./database/
COPY interfaces/ ./interfaces/
COPY models/ ./models/
COPY services/ ./services/

RUN CGO_ENABLED=1 GOOS=linux go build -o prophet_bot ./cmd/bot

# ── Stage 2: Install OpenCode ──────────────────────────────────────────
FROM node:24-bookworm-slim AS opencode-installer

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai@1.3.3 opencode-linux-x64

# ── Stage 3: Final image ───────────────────────────────────────────────
FROM node:24-bookworm-slim

# System deps for better-sqlite3 / sqlite-vec native bindings
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Go binary from builder
COPY --from=go-builder /build/prophet_bot ./prophet_bot
RUN chmod +x ./prophet_bot

# Copy OpenCode CLI from installer stage
COPY --from=opencode-installer /usr/local/lib/node_modules/opencode-ai /usr/local/lib/node_modules/opencode-ai
COPY --from=opencode-installer /usr/local/bin/opencode /usr/local/bin/opencode

# Install Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY agent/ ./agent/
COPY mcp-server.js ./
COPY TRADING_RULES.md ./
COPY opencode.example.jsonc ./opencode.jsonc

# Create data directory (will be overridden by volume mount)
RUN mkdir -p data/sandboxes

# Expose dashboard port
EXPOSE 3737

# Start the agent dashboard (it manages the Go backend internally)
CMD ["node", "agent/server.js"]
