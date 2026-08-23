import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['dist/**', 'node_modules/**', 'fixtures/**'],
    // Git worktree and crash-durability integration tests intentionally fsync
    // real files. Keep the default honest under loaded CI/macOS runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
