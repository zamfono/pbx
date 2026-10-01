// Stands in for Vite's `import.meta.glob` (used by `src/lib/server/mail/templates.ts` and
// `src/lib/server/mcp/guide.ts` to bundle files at build time) when `tool-catalog.mjs` bundles
// the operations tree with plain esbuild instead of Vite: the catalog only needs each operation's
// name, description, min role and confirm flag, never the globbed file contents, so an empty
// module map is enough to let those files load without error.
export function viteGlobShim() {
  return {};
}
