import { defineConfig } from 'vitest/config';
import path from 'path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/**/*.test.ts',
      'server/**/__tests__/**/*.test.ts',
      'server/**/*.test.ts',
      'client/src/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'client/src/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['node_modules/**', 'dist/**', 'build/**'],
    // Use jsdom for frontend tests, node for backend
    environmentMatchGlobs: [
      ['client/**', 'jsdom'],
      ['server/**', 'node'],
      ['tests/**', 'node'],
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/',
        '**/build/',
        '**/coverage/',
        'contracts/',
        'migrations/',
        'scripts/',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
});

