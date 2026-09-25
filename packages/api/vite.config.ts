/// <reference types="vitest/config" />
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * Packages that load a native binding through `require`, which is illegal in the ESM output
 * adapter-node produces: bundling them turns a working module into a `require is not defined`
 * at boot. They are present in the image's own `node_modules`, so the server resolves them at
 * run time instead.
 */
const NATIVE_PACKAGES = ['better-sqlite3', 'sodium-native', 'argon2'];

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    external: NATIVE_PACKAGES
  },
  build: {
    rollupOptions: {
      external: NATIVE_PACKAGES
    }
  },
  test: {
    include: ['src/**/*.test.ts']
  }
});
