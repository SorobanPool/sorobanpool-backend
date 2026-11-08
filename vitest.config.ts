import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Specs that boot an in-process Postgres can be slow on a loaded machine; fail on real problems, not on load.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
