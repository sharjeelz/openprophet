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

# ── Stage 2: Final image ───────────────────────────────────────────────
FROM node:24-bookworm-slim

# System deps for better-sqlite3 / sqlite-vec native bindings + opencode install
RUN apt-get update && apt-get install -y \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode and all Linux platform binaries in one shot so
# opencode-ai can find its native binary in the same node_modules tree
RUN npm install -g opencode-ai@1.3.3 \
    opencode-linux-x64 \
    opencode-linux-x64-baseline \
    2>/dev/null; true

WORKDIR /app

# Copy Go binary from builder
COPY --from=go-builder /build/prophet_bot ./prophet_bot
RUN chmod +x ./prophet_bot

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
