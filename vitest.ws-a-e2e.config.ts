import { defineConfig } from "vitest/config"
import path from "path"

/**
 * WS-A money-path E2E harness — REAL functions, REAL writes, against the CLOUD
 * sandbox (dev job c0a61e44). Not part of `test:unit` and not in any push gate.
 *
 *   npx vitest run --config vitest.ws-a-e2e.config.ts
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/live/ws-a-money-path.e2e.test.ts"],
    globals: true,
    setupFiles: ["./tests/live/_env-ws-a.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
