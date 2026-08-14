import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Live tests only. Separate from the default config so `pnpm test` stays
 * offline, free and deterministic — the live suite costs money and needs a key,
 * and a suite that cannot go green without one eventually gets ignored.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/live/**/*.live.test.ts'],
    testTimeout: 120_000,
    // The pacing pause runs in beforeEach, which has its own separate budget.
    hookTimeout: 120_000,
    // Live calls are rate-limited; running them in parallel just earns 429s.
    fileParallelism: false,
  },
});
