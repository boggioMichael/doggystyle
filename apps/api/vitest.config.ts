import { defineConfig } from 'vitest/config';

export default defineConfig({
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
