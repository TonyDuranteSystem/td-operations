import { defineConfig } from "vitest/config"
import path from "path"

/**
 * client_expenses auto-sync trigger E2E harness (dev job 0dcb0a18) — REAL database, REAL
 * triggers, against the per-worktree isolated LOCAL Supabase stack. Not part of `test:unit`
 * and not in any push gate: it needs the migration applied to a running local stack.
 *
 *   npx vitest run --config vitest.client-expenses-sync-e2e.config.ts
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/live/client-expenses-auto-sync.e2e.test.ts"],
    globals: true,
    setupFiles: ["./tests/live/_env-local-stack.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
