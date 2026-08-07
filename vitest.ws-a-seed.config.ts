import { defineConfig } from "vitest/config"
import path from "path"

/** Sandbox QA fixture builder for WS-A — leaves its rows behind on purpose. */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/live/ws-a-qa-seed.e2e.test.ts"],
    globals: true,
    setupFiles: ["./tests/live/_env-ws-a.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
