#!/usr/bin/env node
// Prints the tool catalog for `skills/zamfono/reference/tools.md` (§12 "Admin skill", Task 46):
// one Markdown table row per operation in the registry, generated instead of hand-written so the
// reference cannot drift from it. Plain `node` cannot resolve the ops modules' NodeNext ".js"
// import specifiers to their ".ts" sources, so this bundles the catalog module with esbuild
// first — the same tool the package's own `build` script uses to bundle `server.ts` — leaving
// `node_modules` packages (native ones, `sodium-native`, included) unbundled, then runs the
// result from a throwaway file so those bare imports still resolve through this package's own
// `node_modules`.
//
// With `--check` it prints nothing and exits non-zero when the committed catalog has drifted from
// the registry, which is the assertion behind `SKILL.md`'s claim that the reference tracks the
// stack's own operations.
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '../src/lib/ops/catalog.ts');
const catalogFile = path.join(
  here,
  '../../../skills/zamfono/reference/tools.md'
);
const CHECK_FLAG = '--check';
const DRIFT_EXIT_CODE = 1;
// Written next to this script, not under `os.tmpdir()`, so the bare `node_modules` imports in
// the bundle (`zod`, `sodium-native`, …) still resolve through this package's own
// `node_modules`; `.tool-catalog.generated.*` is gitignored so a leftover from a killed process
// never shows up as an untracked file.
const outfile = path.join(here, '.tool-catalog.generated.mjs');
const globShim = path.join(here, 'viteGlobShim.mjs');
const WORKSPACE_PREFIX = '@zamfono/';

// Bundles this monorepo's own `.ts` sources (ops/* and @zamfono/shared, both on the ".js"
// specifier / ".ts" file NodeNext convention `node` cannot resolve on its own) while leaving
// every real npm package a bare import, so the result stays small and native modules such as
// `sodium-native` are loaded normally instead of esbuild trying to inline their bindings.
/** @type {import('esbuild').Plugin} */
const externalizeNpmPackages = {
  name: 'externalize-npm-packages',
  setup(pluginBuild) {
    // eslint-disable-next-line require-unicode-regexp -- esbuild compiles this filter as a Go regexp, which rejects the JS u-flag prefix
    pluginBuild.onResolve({ filter: /^[^./]/ }, args =>
      args.path.startsWith(WORKSPACE_PREFIX)
        ? undefined
        : { path: args.path, external: true }
    );
  }
};

/**
 * The 1-based number of the first line on which two texts differ, or 0 when they are identical.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function firstDifferingLine(left, right) {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const limit = Math.max(leftLines.length, rightLines.length);
  for (let line = 0; line < limit; line += 1) {
    if (leftLines[line] !== rightLines[line]) {
      return line + 1;
    }
  }
  return 0;
}

/**
 * The committed catalog, or `undefined` after reporting why it could not be read.
 * @returns {string | undefined}
 */
function readCommittedCatalog() {
  try {
    return readFileSync(catalogFile, 'utf8');
  } catch (error) {
    console.error(`tool-catalog: cannot read ${catalogFile}: ${String(error)}`);
    return undefined;
  }
}

/**
 * Fails the process when the committed catalog and `catalog` disagree, naming the line where
 * they part so the message points at the operation that moved.
 * @param {string} catalog
 * @returns {void}
 */
function checkCommittedCatalog(catalog) {
  const committed = readCommittedCatalog();
  if (committed === undefined) {
    process.exitCode = DRIFT_EXIT_CODE;
    return;
  }
  const line = firstDifferingLine(catalog, committed);
  if (line !== 0) {
    console.error(
      `tool-catalog: ${catalogFile} and the operation registry differ from line ${line} on; regenerate it with scripts/build-skill.sh`
    );
    process.exitCode = DRIFT_EXIT_CODE;
  }
}

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [externalizeNpmPackages],
  inject: [globShim],
  define: { 'import.meta.glob': 'viteGlobShim' },
  outfile
});
try {
  /** @type {{ catalogLines: () => string[] }} */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- a dynamic import of a runtime path is untyped; the JSDoc @type above documents the bundle's real shape
  const generated = await import(pathToFileURL(outfile).href);
  const catalog = `${generated.catalogLines().join('\n')}\n`;
  if (process.argv.includes(CHECK_FLAG)) {
    checkCommittedCatalog(catalog);
  } else {
    process.stdout.write(catalog);
  }
} finally {
  await rm(outfile, { force: true });
}
