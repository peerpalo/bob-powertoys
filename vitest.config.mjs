import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    alias: {
      // Redirect the bare "vscode" module to our hand-rolled mock
      vscode: new URL('./src/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
