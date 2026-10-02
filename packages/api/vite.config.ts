/// <reference types="vitest/config" />
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      // Every component is written in runes; forcing the mode makes `export let`, `$:` and the
      // other legacy syntax a compile error instead of a silent switch back to Svelte 4 semantics.
      compilerOptions: {
        runes: true
      },
      adapter: adapter(),
      // `paths.origin` is left unset: one published image serves every stack, so the origin
      // cannot be fixed at build time. SvelteKit derives it per request from the `Host` header
      // Caddy passes through, over HTTPS (adapter-node's default scheme).
      //
      // `'*'` turns off SvelteKit's built-in CSRF origin check, which refuses every origin-less
      // form POST, and with it the clients of `/oauth/token`, `/oauth/revoke` and multipart REST
      // uploads (§5.2, §10.3). `hooks.server.ts` applies the same check to every other route
      // instead (`lib/server/auth/crossSiteForms.ts`). Remote functions keep SvelteKit's own
      // same-origin check, which this option does not touch.
      csrf: {
        trustedOrigins: ['*']
      },
      // The authentication pages (§5.2) submit through remote `form` functions, which this flag
      // enables. A submission without JavaScript posts to the page's own URL and is answered by a
      // re-render or a 302, so the OAuth flow completes in a browser that runs no scripts at all.
      experimental: {
        remoteFunctions: true
      },
      // The authentication pages are short-lived and nothing reads `updated`, so SvelteKit does
      // not poll for a new deployment.
      version: {
        pollInterval: 0
      }
    })
  ],
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/testEnv.ts']
  }
});
