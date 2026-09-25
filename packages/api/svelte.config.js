import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  // Every component is written in runes; forcing the mode makes `export let`, `$:` and the other
  // legacy syntax a compile error instead of a silent switch back to Svelte 4 semantics.
  compilerOptions: {
    runes: true
  },
  kit: {
    adapter: adapter(),
    // `'*'` turns off SvelteKit's built-in CSRF origin check, which refuses every origin-less form
    // POST, and with it the clients of `/oauth/token`, `/oauth/revoke` and multipart REST uploads
    // (§5.2, §10.3). `hooks.server.ts` applies the same check to every other route instead
    // (`lib/auth/crossSiteForms.ts`). Remote functions called from JavaScript keep SvelteKit's
    // own same-origin check, which this option does not touch.
    csrf: {
      trustedOrigins: ['*']
    },
    // The authentication pages (§5.2) submit through remote `form` functions, which this flag
    // enables. A submission without JavaScript posts to the page's own URL and is answered by a
    // re-render or a 302, so the OAuth flow completes in a browser that runs no scripts at all.
    experimental: {
      remoteFunctions: true
    }
  }
};

export default config;
