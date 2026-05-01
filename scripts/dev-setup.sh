#!/bin/bash
# dev-setup.sh — reset this machine to sandbox environment.
# Run at the start of any session, or whenever environment state is uncertain.
# Idempotent — safe to run multiple times.
#
# What it does:
#   1. Links the Vercel CLI to td-operations-sandbox (not production)
#   2. Pulls sandbox environment variables into .env.local
#   3. Generates .mcp.json with sandbox MCP connection (Claude Code tool routing)
#   4. Verifies both files point to sandbox before finishing
#
# After running this script, the machine is in a safe state:
#   - git push goes to origin/sandbox (not main)
#   - npm run dev hits sandbox Supabase (not production)
#   - vercel deploy targets td-operations-sandbox (not production)
#   - Claude Code MCP tools route to sandbox Supabase by default

set -e

PROD_REF="ydzipybqeebtpcvsbtvs"
SANDBOX_REF="xjcxlmlpeywtwkhstjlw"
SANDBOX_PROJECT="td-operations-sandbox"

echo ""
echo "🔧 Setting up sandbox environment..."
echo ""

# Step 1: Link Vercel CLI to sandbox project
echo "1/3 Linking to $SANDBOX_PROJECT..."
vercel link --project "$SANDBOX_PROJECT" --yes

# Step 2: Pull sandbox env vars
echo "2/3 Pulling sandbox environment variables into .env.local..."
vercel env pull .env.local --yes

# Step 3: Generate .mcp.json with sandbox MCP connection
echo "3/4 Generating .mcp.json for sandbox MCP connection..."
SANDBOX_MCP_KEY=$(grep 'TD_MCP_API_KEY' .env.local | head -1 | sed 's/TD_MCP_API_KEY="\(.*\)"/\1/')
cat > .mcp.json << EOF
{
  "mcpServers": {
    "td-ops-sandbox": {
      "type": "http",
      "url": "https://td-operations-sandbox.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer ${SANDBOX_MCP_KEY}"
      }
    }
  }
}
EOF

# Step 4: Verify both files are correct before finishing
echo "4/4 Verifying..."

PROJECT=$(python3 -c "import json; print(json.load(open('.vercel/project.json')).get('projectName',''))" 2>/dev/null || echo "UNKNOWN")
SUPABASE_URL=$(grep 'NEXT_PUBLIC_SUPABASE_URL' .env.local 2>/dev/null | head -1 | sed 's/.*"\(.*\)".*/\1/' || echo "MISSING")

FAILED=0

if [ "$PROJECT" != "$SANDBOX_PROJECT" ]; then
  echo "❌ .vercel/project.json still points to: $PROJECT (expected $SANDBOX_PROJECT)"
  FAILED=1
fi

if echo "$SUPABASE_URL" | grep -q "$PROD_REF"; then
  echo "❌ .env.local still has PRODUCTION Supabase URL"
  FAILED=1
fi

if ! echo "$SUPABASE_URL" | grep -q "$SANDBOX_REF"; then
  echo "❌ .env.local does not have sandbox Supabase URL (expected ref $SANDBOX_REF)"
  FAILED=1
fi

if [ ! -f ".mcp.json" ] || ! grep -q "td-operations-sandbox" .mcp.json; then
  echo "❌ .mcp.json was not generated correctly"
  FAILED=1
fi

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "⛔ Setup failed — environment is NOT safe. Do not run any code until this is fixed."
  exit 1
fi

echo ""
echo "✅ Machine is in SANDBOX:"
echo "   Vercel project : $PROJECT"
echo "   Supabase       : $SUPABASE_URL"
echo "   MCP tools      : td-operations-sandbox.vercel.app"
echo ""
echo "Safe to work. All code and MCP tools run against sandbox. Production is untouched."
echo ""
