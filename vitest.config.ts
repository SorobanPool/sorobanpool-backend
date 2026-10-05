import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // Specs that boot an in-process Postgres can be slow on a loaded machine; fail on real problems, not on load.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
