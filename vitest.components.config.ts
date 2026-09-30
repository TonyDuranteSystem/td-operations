import { defineConfig } from "vitest/config"
import path from "path"
// Renders React components to static HTML and checks what a person would read. NOT part of test:unit. Run:
//   npx vitest run --config vitest.components.config.ts
export default defineConfig({
  esbuild: { jsx: "automatic" },
  // vitest 4 / vite 7 transform TSX with oxc; the app tsconfig says jsx "preserve", so say it plainly here
  oxc: { jsx: { runtime: "automatic" } },
  test: { environment: "node", include: ["tests/components/**/*.test.ts"], globals: true },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
})
