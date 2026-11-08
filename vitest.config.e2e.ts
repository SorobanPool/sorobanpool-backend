import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    testTimeout: 60_000,
    // Every suite spends the same sponsor account. Its sequence-number lock is per process, so suites in parallel
    // workers would race on sequence numbers: run files one at a time.
    fileParallelism: false,
  },
});
