import { beforeEach, describe, expect, it } from 'vitest';

import '#lib/api/ops/index.js';

import { ApiError } from '#lib/api/errors.js';
import { call, ConfirmationRequired, type Actor } from '#lib/api/ops/core.js';
import { U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import { renderTemplate } from '#lib/components/system/mailTemplate.js';

import type { MailTemplateWire } from './mailTemplates';

const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };

const run = <O>(name: string, input: unknown, confirmed = false): O =>
  call<O>(name, input, { actor: jonas, channel: 'ui', confirmed });

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  resetDb();
});

describe('mail templates', () => {
  it('lists every kind in the tenant language and serves shipped text for any language', () => {
    const items = run<{ items: MailTemplateWire[] }>(
      'mailTemplates.list',
      {}
    ).items;
    expect(items).toHaveLength(7);
    expect(items.every(item => item.language === 'de')).toBe(true);
    const french = run<MailTemplateWire>('mailTemplates.get', {
      kind: 'reset',
      language: 'fr'
    });
    expect(french.source).toBe('builtin');
    expect(french.bodyText).toContain('{{link}}');
  });

  it('accepts only the kind’s placeholders and requires link for setup', () => {
    const base = {
      kind: 'setup',
      language: 'en',
      subject: 'Welcome',
      bodyText: 'Hi {{recipientName}}'
    };
    expect(refusal(() => run('mailTemplates.put', base)).code).toBe(
      'templateMissingRequired'
    );
    expect(
      refusal(() =>
        run('mailTemplates.put', {
          ...base,
          bodyText: '{{link}} {{callerName}}'
        })
      ).code
    ).toBe('templateUnknownPlaceholder');
    const saved = run<MailTemplateWire>('mailTemplates.put', {
      ...base,
      bodyText: 'Hi {{recipientName}}, {{link}}'
    });
    expect(saved.source).toBe('tenant');
    expect(store.db.audit[0]).toMatchObject({
      operation: 'mailTemplates.put',
      entityId: 'setup:en',
      undoable: true
    });
  });

  it('delete asks for confirmation and returns to the shipped template', () => {
    run('mailTemplates.put', {
      kind: 'reset',
      language: 'it',
      subject: 'Reset',
      bodyText: '{{link}}'
    });
    expect(() =>
      run('mailTemplates.delete', { kind: 'reset', language: 'it' })
    ).toThrow(ConfirmationRequired);
    run('mailTemplates.delete', { kind: 'reset', language: 'it' }, true);
    expect(
      run<MailTemplateWire>('mailTemplates.get', {
        kind: 'reset',
        language: 'it'
      }).source
    ).toBe('builtin');
    expect(
      refusal(() =>
        run('mailTemplates.delete', { kind: 'reset', language: 'it' }, true)
      ).code
    ).toBe('mailTemplateNoOverride');
  });

  it('test sends to the caller in the tenant language', () => {
    expect(
      run<{ status: string; language: string }>('mailTemplates.test', {
        kind: 'voicemail'
      })
    ).toEqual({ status: 'sent', language: 'de' });
  });

  it('renders conditions and dates for the preview', () => {
    const text = renderTemplate(
      '{{#if callerName}}{{callerName}}{{else if callerNumber}}{{callerNumber}}{{else}}anon{{/if}} <{{x}}>',
      { callerNumber: '+49', x: '<b>' },
      { language: 'en', timezone: null, escape: true }
    );
    expect(text).toBe('+49 <&lt;b&gt;>');
  });
});
