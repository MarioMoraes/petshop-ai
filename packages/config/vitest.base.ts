import { defineConfig } from 'vitest/config'

/** Base compartilhada dos testes (SPEC §10). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
