import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

/**
 * The mockup is a SvelteKit app with the hash router, built by adapter-static into one
 * self-contained HTML file (`bundleStrategy: 'inline'`, fonts and audio inlined by Vite), so it
 * opens from disk and publishes as a single page.
 */
export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: { runes: true },
      adapter: adapter({
        pages: '../docs/mockup',
        assets: '../docs/mockup',
        fallback: 'index.html',
        strict: false
      }),
      router: { type: 'hash' },
      output: { bundleStrategy: 'inline' },
      paths: { relative: true }
    })
  ],
  build: {
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 10_000
  },
  test: {
    include: ['src/**/*.test.ts']
  }
});
