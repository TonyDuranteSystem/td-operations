import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  // component files (.tsx) can be imported by a unit test: tsconfig keeps JSX for Next, so tell the test transform to compile it
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
