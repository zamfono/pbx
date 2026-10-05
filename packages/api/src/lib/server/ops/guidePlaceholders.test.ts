import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SIP_HEADER_PLACEHOLDERS } from '@zamfono/shared';

import { PLACEHOLDERS } from '../mail/index.js';

/**
 * The admin guide lists the placeholders of the mail templates and of the SIP header templates by
 * hand, each with its meaning; this holds both lists to the tables the code validates with, so a
 * placeholder added, renamed or dropped in one fails here until the guide says the same.
 */
const GUIDE_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../../docs/guide'
);

function guide(file: string): string {
  return readFileSync(path.join(GUIDE_DIR, file), 'utf8');
}

/** The `` `name` `` code spans of `text` that are plain names, sorted. */
function names(text: string): string[] {
  return [...text.matchAll(/`(?<span>[^`]+)`/gu)]
    .map(match => match.groups?.span ?? '')
    .filter(span => /^\w+$/u.test(span))
    .sort();
}

/** `text` from the heading `heading` up to the next heading of its level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

describe('the guide’s placeholder lists', () => {
  it('lists each mail kind’s placeholders and required ones as the templates check them', () => {
    const text = section(
      guide('mail-templates.md'),
      '## Placeholders per kind'
    );
    const common = /^Every kind offers (?<list>[\s\S]*?) In addition:/mu.exec(
      text
    )?.groups?.list;
    expect(common).toBeDefined();
    const rows = new Map(
      [
        ...text.matchAll(
          /^\| `(?<kind>\w+)` +\|(?<offered>[^|]*)\|(?<required>[^|]*)\|$/gmu
        )
      ].map(match => [match.groups?.kind ?? '', match.groups ?? {}])
    );
    expect([...rows.keys()].sort()).toEqual(Object.keys(PLACEHOLDERS).sort());
    for (const [kind, { offered, required }] of Object.entries(PLACEHOLDERS)) {
      const row = rows.get(kind) ?? {};
      expect(
        [...names(common ?? ''), ...names(row.offered ?? '')].sort(),
        kind
      ).toEqual([...offered].sort());
      expect(names(row.required ?? ''), `${kind} required`).toEqual(
        [...required].sort()
      );
    }
  });

  it('lists every SIP header placeholder, and only those', () => {
    const listed = [
      ...guide('recipes/forward-to-ai-agent.md').matchAll(
        /^ *\| `\{\{(?<name>\w+)\}\}` /gmu
      )
    ].map(match => match.groups?.name ?? '');
    expect(listed.sort()).toEqual(Object.keys(SIP_HEADER_PLACEHOLDERS).sort());
  });
});
