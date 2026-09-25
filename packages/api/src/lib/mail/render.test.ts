import { describe, expect, it } from 'vitest';

import { nowIso, openDb, type Db } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { compileTemplate, resolveTemplate } from './render.js';
import {
  loadBuiltinTemplate,
  type Language,
  type TemplateKind
} from './templates.js';

const BUILTIN_KINDS: TemplateKind[] = [
  'voicemail',
  'missedCall',
  'setup',
  'reset'
];
const BUILTIN_LANGUAGES: Language[] = ['de', 'en', 'es', 'fr', 'it', 'ru'];

async function migratedDb(): Promise<Db> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  return db;
}

describe('compileTemplate', () => {
  it('rejects a placeholder the kind does not offer', () => {
    expect(() =>
      compileTemplate('reset', 'Subject', '{{unknownField}} {{link}}', null)
    ).toThrow('template: unknown placeholder unknownField');
  });

  it('rejects a disallowed helper', () => {
    expect(() =>
      compileTemplate('reset', '{{link}}', '{{lookup a b}} {{link}}', null)
    ).toThrow('template: helper lookup not allowed');
  });

  it('rejects a body missing a required placeholder', () => {
    expect(() =>
      compileTemplate('reset', 'Subject with no link', 'Body text', null)
    ).toThrow('template: missing required link');
  });

  it('renders {{date value}} in the tenant timezone and language', () => {
    const template = compileTemplate(
      'voicemail',
      'Subject',
      '{{date receivedAt}}',
      null
    );
    const values = { receivedAt: '2026-06-15T12:00:00.000Z' };
    const berlin = template.render(values, {
      language: 'de',
      timezone: 'Europe/Berlin'
    });
    const newYork = template.render(values, {
      language: 'en',
      timezone: 'America/New_York'
    });
    // CEST is UTC+2 in June, EDT is UTC-4: the same instant renders as different local times.
    expect(berlin.text).toContain('14:00');
    expect(newYork.text).toContain('8:00');
  });

  it('rejects a triple-stash mustache in the HTML body', () => {
    expect(() =>
      compileTemplate(
        'voicemail',
        'Subject',
        '{{callerName}}',
        '<p>{{{callerName}}}</p>'
      )
    ).toThrow('template: unescaped output not allowed');
  });

  it('rejects a partial', () => {
    expect(() =>
      compileTemplate('reset', '{{link}}', '{{link}} {{> evil}}', null)
    ).toThrow('template: PartialStatement not allowed');
  });

  it('HTML-escapes a placeholder value in the HTML body but not in the text body', () => {
    const template = compileTemplate(
      'voicemail',
      'Subject',
      '{{callerName}}',
      '<p>{{callerName}}</p>'
    );
    const rendered = template.render(
      { callerName: '<b>Eve</b>' },
      { language: 'en', timezone: null }
    );
    expect(rendered.text).toBe('<b>Eve</b>');
    expect(rendered.html).toBe('<p>&lt;b&gt;Eve&lt;/b&gt;</p>');
  });
});

describe('loadBuiltinTemplate', () => {
  for (const kind of BUILTIN_KINDS) {
    for (const language of BUILTIN_LANGUAGES) {
      it(`compiles the shipped ${kind}.${language} template`, () => {
        const source = loadBuiltinTemplate(kind, language);
        expect(() =>
          compileTemplate(
            kind,
            source.subject,
            source.bodyText,
            source.bodyHtml
          )
        ).not.toThrow();
      });
    }
  }
});

describe('resolveTemplate', () => {
  it('prefers the tenant row over the shipped built-in', async () => {
    const db = await migratedDb();
    await db
      .insertInto('mailTemplates')
      .values({
        kind: 'voicemail',
        language: 'en',
        subject: 'Tenant override subject',
        bodyText: 'Tenant override body',
        bodyHtml: null,
        updatedAt: nowIso()
      })
      .execute();

    const template = await resolveTemplate(db, 'voicemail', 'en');
    const rendered = template.render({}, { language: 'en', timezone: null });
    expect(rendered.subject).toBe('Tenant override subject');
  });
});
