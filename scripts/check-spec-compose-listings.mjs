#!/usr/bin/env node
// docs/spec.md §6.3 prints deploy/compose.yaml, its two attachment overlays and the Caddyfiles as
// fenced listings, prose next to the actual files. Nothing keeps a copy-pasted listing in step with
// the file it quotes, so this fails CI the moment one drifts from the other.
//
// A listing is found two ways: the fence right after the "### 6.3 Compose stack" heading is always
// deploy/compose.yaml (it opens with prose, not a "# <filename>" comment, so it can't be found the
// other way); every other fence is matched by its own first line, "# <name>" or "# <name> — …",
// when <name> is a file that exists under deploy/.
//
// Each listing has to match its file byte for byte. On a mismatch this prints a unified diff and
// says where to fix it: the listing in docs/spec.md §6.3, with the change logged in
// docs/spec-changes.md.
//
//   node scripts/check-spec-compose-listings.mjs
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_FAILURE = 1;
const HEADING = '### 6.3 Compose stack';
const FENCE = /^```(?:\S*)\s*$/u;
const NAMED_LISTING = /^#\s*(?<name>[A-Za-z0-9._-]+)\b/u;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {{ lines: string[], startLine: number }} FenceBlock */

/**
 * Splits `text` into its fenced code blocks (```lang … ```), in document order.
 * @param {string} text
 * @returns {FenceBlock[]}
 */
function findFenceBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let contentStart = -1;
  for (const [index, line] of lines.entries()) {
    if (!FENCE.test(line)) continue;
    if (contentStart === -1) {
      contentStart = index + 1;
      continue;
    }
    blocks.push({
      lines: lines.slice(contentStart, index),
      startLine: contentStart
    });
    contentStart = -1;
  }
  return blocks;
}

/**
 * Maps a fence block to the deploy/ file it quotes, or null when it quotes none.
 * @param {FenceBlock} block
 * @param {boolean} isComposeYamlListing
 * @returns {string | null}
 */
function mappedDeployFile(block, isComposeYamlListing) {
  if (isComposeYamlListing) return 'compose.yaml';
  const [firstLine] = block.lines;
  if (firstLine === undefined) return null;
  const match = NAMED_LISTING.exec(firstLine);
  const candidate = match?.groups?.name;
  if (candidate === undefined) return null;
  if (candidate !== 'Caddyfile' && !/\.(?:yaml|caddy)$/u.test(candidate))
    return null;
  return existsSync(join(repoRoot, 'deploy', candidate)) ? candidate : null;
}

/**
 * A `diff -u` between two strings, computed through real files since Node ships no diff of its
 * own; the temporary directory is always removed before returning.
 * @param {string} expected
 * @param {string} actual
 * @returns {string}
 */
function unifiedDiff(expected, actual) {
  const dir = mkdtempSync(join(tmpdir(), 'check-spec-compose-listings-'));
  const expectedPath = join(dir, 'docs-spec.md');
  const actualPath = join(dir, 'deploy-file');
  writeFileSync(expectedPath, expected);
  writeFileSync(actualPath, actual);
  try {
    return execFileSync('diff', ['-u', expectedPath, actualPath], {
      encoding: 'utf8'
    });
  } catch (error) {
    // `diff` exits 1 (not an error here, just "they differ") and still writes the diff to stdout;
    // execFileSync throws on any non-zero exit, so that stdout is read back from the exception.
    const stdout =
      typeof error === 'object' && error !== null && 'stdout' in error
        ? error.stdout
        : undefined;
    return typeof stdout === 'string' ? stdout : '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every listing this run found, each already checked against its deploy/ file.
 * @returns {{ file: string, matches: boolean, diff: string }[]}
 */
function checkListings() {
  const specPath = join(repoRoot, 'docs/spec.md');
  const spec = readFileSync(specPath, 'utf8');
  const blocks = findFenceBlocks(spec);
  const headingAt = spec.indexOf(HEADING);
  if (headingAt === -1) {
    throw new Error(
      `"${HEADING}" is missing from docs/spec.md; the compose.yaml listing moved`
    );
  }
  const headingLine = spec.slice(0, headingAt).split('\n').length - 1;
  const composeYamlBlock = blocks.find(block => block.startLine > headingLine);
  if (composeYamlBlock === undefined) {
    throw new Error(`no fenced listing follows "${HEADING}" in docs/spec.md`);
  }

  const results = [];
  for (const block of blocks) {
    const file = mappedDeployFile(block, block === composeYamlBlock);
    if (file === null) continue;
    const expected = `${block.lines.join('\n')}\n`;
    const actual = readFileSync(join(repoRoot, 'deploy', file), 'utf8');
    results.push({
      file,
      matches: expected === actual,
      diff: expected === actual ? '' : unifiedDiff(expected, actual)
    });
  }
  return results;
}

function main() {
  const results = checkListings();
  if (results.length === 0) {
    throw new Error(
      'found no docs/spec.md listing that quotes a deploy/ file; the check protects nothing'
    );
  }

  const failures = results.filter(result => !result.matches);
  for (const result of results) {
    console.log(
      `${result.matches ? 'OK  ' : 'FAIL'} docs/spec.md §6.3 vs deploy/${result.file}`
    );
  }
  for (const failure of failures) {
    console.error(`\n--- deploy/${failure.file} ---`);
    console.error(failure.diff);
    console.error(
      `update the listing in docs/spec.md §6.3 and log the change in docs/spec-changes.md`
    );
  }
  if (failures.length > 0) process.exit(EXIT_FAILURE);
}

main();
