import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    // P1.7 characterization tests — exercise end-to-end flows known to
    // have produced recent bugs. Live in tests/integration/ to keep the
    // tests/unit/ suite fast and focused on pure logic.
    include: ["tests/integration/**/*.test.ts"],
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
