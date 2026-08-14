import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Live tests need a funded API key and network; they run under
    // `pnpm test:live` with their own config so this suite stays offline,
    // free and deterministic.
    exclude: ['tests/live/**'],
  },
});
