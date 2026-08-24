import { defineConfig } from "vitest/config"
import path from "path"

/**
 * Renewal-date sync fix E2E harness (dev job 8bd0e51a) — REAL database, REAL
 * code, against the per-worktree isolated LOCAL Supabase stack. Not part of
 * `test:unit` and not in any push gate: it's a live-DB harness like the
 * client_expenses sync suite it mirrors.
 *
 *   npx vitest run --config vitest.renewal-date-sync-e2e.config.ts
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/live/renewal-date-sync.e2e.test.ts"],
    globals: true,
    setupFiles: ["./tests/live/_env-local-stack.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
