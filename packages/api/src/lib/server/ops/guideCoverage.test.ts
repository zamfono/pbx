import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { registry } from './registry.js';
// Side-effect import: fills the registry with every area's operations.
import './index.js';

/**
 * An MCP client configures the stack from what the server tells it (§10.5): the tool list and
 * the admin guide behind `zamfono.help`. A tool's one-line description cannot carry a concept, so
 * every operation area, each directory under `ops/`, is named somewhere in the guide, by one of
 * its tools (`didBlocks.create`) or by the area itself in code (`` `didBlocks` ``). An area the
 * guide never names fails here, unless it is listed below.
 */
const OPS_DIR = import.meta.dirname;
const GUIDE_DIR = path.resolve(OPS_DIR, '../../../../../../docs/guide');

/**
 * Areas the guide may leave out, each with its reason. A reason starting `TODO(guide)` marks an
 * area that does need guide text and has none yet; drop it from here with the topic that covers
 * it.
 */
const UNCOVERED_AREAS = new Map<string, string>();

function guideText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return guideText(full);
      }
      return entry.name.endsWith('.md') ? readFileSync(full, 'utf8') : '';
    })
    .join('\n');
}

function areas(): string[] {
  return readdirSync(OPS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

/** Whether `text` names `area` in code or names one of its registered tools. */
function names(text: string, area: string): boolean {
  if (text.includes(`\`${area}\``)) {
    return true;
  }
  return [...registry.keys()]
    .filter(tool => tool.startsWith(`${area}.`))
    .some(tool =>
      new RegExp(`\\b${tool.replaceAll('.', '\\.')}\\b`, 'u').test(text)
    );
}

describe('the admin guide names every operation area', () => {
  const text = guideText(GUIDE_DIR);

  it('covers each area not listed as uncovered', () => {
    const missing = areas().filter(
      area => !UNCOVERED_AREAS.has(area) && !names(text, area)
    );
    expect(missing).toEqual([]);
  });

  it('lists as uncovered only real areas the guide still leaves out', () => {
    const stale = [...UNCOVERED_AREAS.keys()].filter(
      area => !areas().includes(area) || names(text, area)
    );
    expect(stale).toEqual([]);
  });
});
