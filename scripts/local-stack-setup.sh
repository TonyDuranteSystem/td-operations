#!/usr/bin/env bash
# local-stack-setup.sh — ONE-TIME per-machine bootstrap for isolated local dev stacks.
#
# Installs the runtime that env-up.sh needs: Colima (headless Docker daemon — free,
# no Docker Desktop license, no sudo/GUI), the Supabase CLI, the Docker CLI, and the
# Postgres client tools (libpq → pg_dump/psql). Idempotent: safe to re-run.
# Portable across Apple Silicon and Intel — uses `brew --prefix`, no hardcoded paths.
#
# Run once on each machine:  bash scripts/local-stack-setup.sh
set -euo pipefail

command -v brew >/dev/null 2>&1 || {
  echo "❌ Homebrew is required. Install it from https://brew.sh then re-run."
  exit 1
}

echo "🔧 local-stack-setup — installing tooling (idempotent)…"

# Formulae (install into the Homebrew prefix; no sudo, no GUI, no license)
for f in colima docker libpq; do
  if brew list "$f" >/dev/null 2>&1; then
    echo "  ✓ $f already installed"
  else
    echo "  → installing $f"
    brew install "$f"
  fi
done

# Supabase CLI lives in a tap
if brew list supabase >/dev/null 2>&1; then
  echo "  ✓ supabase CLI already installed"
else
  echo "  → installing supabase CLI"
  brew install supabase/tap/supabase
fi

# Start the Colima VM if it isn't already running (enough for several stacks)
if colima status >/dev/null 2>&1; then
  echo "  ✓ Colima already running"
else
  echo "  → starting Colima VM (4 CPU / 8 GB / 60 GB disk)…"
  colima start --cpu 4 --memory 8 --disk 60
fi

PGBIN="$(brew --prefix libpq)/bin"
echo ""
echo "✅ Ready. Tooling versions:"
echo "   colima  : $(colima version 2>/dev/null | head -1)"
echo "   docker  : $(docker --version 2>/dev/null)"
echo "   supabase: $(supabase --version 2>/dev/null)"
echo "   pg_dump : $("$PGBIN/pg_dump" --version 2>/dev/null)"
echo ""
echo "Next: in any worktree that has a sandbox .env.local, run:  bash scripts/env-up.sh"
