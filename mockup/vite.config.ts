import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

/**
 * The mockup is a single-page SvelteKit app built by adapter-static into `build/`: every route is
 * the fallback `index.html`, which the web server answers for any path without a file
 * (deploy/Caddyfile).
 */
export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: { runes: true },
      adapter: adapter({
        pages: 'build',
        assets: 'build',
        fallback: 'index.html',
        strict: false
      })
    })
  ],
  test: {
    include: ['src/**/*.test.ts']
  }
});
