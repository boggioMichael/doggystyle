import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@doggystyle/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['./tests/setupEnv.ts'],
    testTimeout: 30_000,
    // One database, one process: these suites share state deliberately.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
