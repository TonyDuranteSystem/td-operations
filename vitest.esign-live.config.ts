import { defineConfig } from "vitest/config"
import path from "path"
// Live sandbox tests — NOT part of test:unit / CI. Run explicitly:
//   npx vitest run --config vitest.esign-live.config.ts
export default defineConfig({
  test: { environment: "node", include: ["tests/live/**/*.test.ts"], globals: true, setupFiles: ["./tests/live/_env.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
})
