// Stands in for SvelteKit's `$env/dynamic/private` when `tool-catalog.mjs` bundles the operations
// tree with plain esbuild instead of Vite: the catalog reads no setting, so the process's own
// environment, which is what that module holds in the built server, is enough to let the
// operations load.
export { env } from 'node:process';
