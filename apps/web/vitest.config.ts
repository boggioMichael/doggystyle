import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@doggystyle/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Only collect unit/component tests — Playwright E2E lives under e2e/ and
    // is run via `npm run test:e2e`, not Vitest.
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    exclude: ['e2e/**', 'playwright/**', 'node_modules/**'],
  },
});
