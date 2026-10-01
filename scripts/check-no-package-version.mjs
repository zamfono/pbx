#!/usr/bin/env node
// Fails when a tracked package.json carries a "version" field. Every package.json in this
// repository is "private": true and never published, and the git tag is the only version source
// (docs/spec.md §7 "Version"); a stray "version" would be a second, driftable source of truth
// that nothing keeps in step with the tag.
//
//   node scripts/check-no-package-version.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXIT_FAILURE = 1;

const tracked = execFileSync('git', ['ls-files', '*package.json'], {
  encoding: 'utf8'
})
  .split('\n')
  .filter(Boolean);

// JSON.parse is necessarily `any`; there is nothing narrower to assign or pass it as before
// asking whether the parsed object owns the one key this check cares about.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
/** @param {string} path @returns {boolean} */
function hasVersionField(path) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  return Object.hasOwn(pkg, 'version');
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */

const offenders = tracked.filter(hasVersionField);

if (offenders.length > 0) {
  for (const path of offenders) {
    console.error(
      `${path} carries a "version" field; remove it (docs/spec.md §7 "Version")`
    );
  }
  process.exit(EXIT_FAILURE);
}
