import { defineConfig } from "vitest/config"
import path from "path"

/**
 * Bank-feed E2E harness — REAL functions, REAL database writes, against the per-worktree
 * isolated LOCAL Supabase stack. Not part of `test:unit` and not in any push gate: it needs a
 * running local stack and it is deliberately destructive.
 *
 *   npx vitest run --config vitest.bankfeed-e2e.config.ts
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/live/bank-feed-reconciliation.e2e.test.ts"],
    globals: true,
    setupFiles: ["./tests/live/_env-local-stack.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
