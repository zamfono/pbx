// See https://svelte.dev/docs/kit/types#app.d.ts
import type { Dictionary } from '$lib/i18n/index.js';
import type { Actor } from '$lib/server/ops/types.js';

declare global {
  namespace App {
    // interface Error {}
    /** Set by `hooks.server.ts` on every request; non-`null` only inside `/api/v1/*` (§10.3). */
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- SvelteKit's own generated types extend `App.Locals` by declaration merging, which only an `interface` supports
    interface Locals {
      actor: Actor | null;
      clientId: string | null;
    }
    /** Every authentication page's load returns at least these two (§5.2 "Authentication
     *  pages"); declaring them here is what types the `$app/state` `page.data` a `+error.svelte`
     *  reads them from, since an error boundary receives no `data` prop of its own. */
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- SvelteKit's own generated types extend `App.PageData` by declaration merging, which only an `interface` supports
    interface PageData {
      dictionary?: Dictionary;
      companyName?: string;
    }
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
