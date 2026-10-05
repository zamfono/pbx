import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';

import Page from './+page.svelte';

const state = vi.hoisted(() => ({
  url: new URL('https://pbx.example/auth/error')
}));

vi.mock('$app/state', () => ({ page: state }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

const dict = dictionaryFor('en');

function bodyFor(search: string): string {
  state.url = new URL(`https://pbx.example/auth/error${search}`);
  return render(Page, {
    props: { data: { dictionary: dict, companyName: 'Acme' } }
  }).body;
}

describe('the error page (§5.2 "Authentication pages")', () => {
  it('shows the generic message for a reason named like an Object.prototype member', () => {
    const body = bodyFor('?reason=constructor');
    expect(body).toContain(dict.error.generic);
    expect(body).not.toContain('native code');
  });
});
