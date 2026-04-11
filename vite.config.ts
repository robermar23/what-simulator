import { defineConfig } from 'vite';

/**
 * Vite configuration for What Simulator.
 *
 * Keep this minimal — the app is a vanilla TypeScript SPA with no framework.
 * The only non-default config required is the test runner (Vitest) setup and
 * SharedArrayBuffer cross-origin isolation headers (needed for Atomics in
 * Phase 4 when Web Workers share buffers).
 */
export default defineConfig({
  // Ensure the dev server sends the COOP/COEP headers required by
  // SharedArrayBuffer — harmless in Phase 1, required from Phase 4 onward.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  // Vitest configuration lives here so a separate vitest.config.ts is not needed.
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['src/main.ts', 'src/**/*.d.ts'],
    },
  },
});
