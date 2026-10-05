import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';

import Page from './+page.svelte';

const state = vi.hoisted((): { result: unknown } => ({ result: undefined }));

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('./setPassword.remote.js', async () => ({
  setPassword: (await import('#testing/remoteFormStub.js')).remoteFormStub(
    state
  )
}));

const dictionary = dictionaryFor('en');

function bodyFor(data: { token: string | null; done: boolean }): string {
  return render(Page, {
    props: { data: { ...data, dictionary, companyName: 'Acme' } }
  }).body;
}

describe('the set-password page (§5.2 "Authentication pages")', () => {
  it('announces a refusal and marks the password box invalid, described by it', () => {
    state.result = { message: 'refused' };
    const body = bodyFor({ token: 't', done: false });
    expect(body).toMatch(/<p[^>]*id="refusal"[^>]*role="alert"[^>]*>refused/u);
    expect(body).toMatch(
      /<input[^>]*name="_password"[^>]*aria-invalid="true"[^>]*aria-describedby="refusal"/u
    );
  });

  it('leaves the password box unmarked before a refusal', () => {
    state.result = undefined;
    expect(bodyFor({ token: 't', done: false })).not.toContain('aria-invalid');
  });

  it('announces the confirmation as a status', () => {
    expect(bodyFor({ token: null, done: true })).toMatch(
      /<p[^>]*role="status"[^>]*>/u
    );
  });
});
