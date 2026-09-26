import { defineConfig } from "vitest/config"
import path from "path"
// CRM Store slice 6 live route E2E against the SANDBOX — NOT part of test:unit / CI. Run explicitly:
//   npx vitest run --config vitest.crm-store-live.config.ts
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/crm-store-s6-routes.test.ts"],
    globals: true,
    setupFiles: ["./tests/live/_env.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
})
