import { defineConfig } from 'vitest/config'
import path from 'path'

// LIVE sandbox matrix runner — deliberately OUTSIDE the default include glob
// (tests/unit/**) so `npm run test:unit` never touches a real database.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['qa/**/*.live.ts'],
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
})
