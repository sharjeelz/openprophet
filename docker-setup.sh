#!/bin/bash
# OpenProphet Docker Setup — run once on Ubuntu before starting the container

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}OpenProphet Docker Setup${NC}"
echo ""

# 1. Check .env exists
if [ ! -f .env ]; then
    echo -e "${RED}No .env file found. Create one with your API keys first.${NC}"
    echo "Required: ALPACA_PUBLIC_KEY, ALPACA_SECRET_KEY, AGENT_AUTH_TOKEN"
    exit 1
fi
echo -e "${GREEN}[ok] .env found${NC}"

# 2. Create data directory
mkdir -p data/sandboxes
echo -e "${GREEN}[ok] data/ directory ready${NC}"

# 3. Create the named volume and authenticate OpenCode inside it
echo ""
echo -e "${YELLOW}Setting up OpenCode authentication...${NC}"
echo "This will open an interactive login. Follow the prompts."
echo ""

# Create the volume if it doesn't exist
docker volume create openprophet_opencode-auth 2>/dev/null || true

# Run OpenCode auth inside a temporary container that mounts the volume
docker run --rm -it \
    -v openprophet_opencode-auth:/root/.local/share/opencode \
    node:24-bookworm-slim \
    bash -c "npm install -g opencode-ai@1.3.3 -q && opencode auth login"

echo ""
echo -e "${GREEN}[ok] OpenCode authenticated${NC}"

# 4. Build and start
echo ""
echo -e "${YELLOW}Building and starting OpenProphet...${NC}"
docker compose up -d --build

echo ""
echo -e "${GREEN}Done! OpenProphet is running at http://localhost:3737${NC}"
if grep -q "AGENT_AUTH_TOKEN" .env; then
    TOKEN=$(grep AGENT_AUTH_TOKEN .env | cut -d= -f2 | tr -d '"')
    echo -e "${GREEN}Dashboard URL: http://localhost:3737?token=${TOKEN}${NC}"
fi
