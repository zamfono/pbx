import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';

import Page from './+page.svelte';

const state = vi.hoisted((): { result: unknown } => ({ result: undefined }));

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('./authorize.remote.js', async () => {
  const { remoteFormStub } = await import('#testing/remoteFormStub.js');
  return {
    login: remoteFormStub(state),
    consent: remoteFormStub({ result: undefined })
  };
});

const data = {
  dictionary: dictionaryFor('en'),
  companyName: 'Acme',
  mailConfigured: false,
  clientName: null,
  sso: null,
  authorize: null,
  consent: null
};

describe('the login page (§5.2 "Authentication pages")', () => {
  it('announces a refusal and marks both boxes invalid, described by it', () => {
    state.result = { message: 'refused', email: 'a@b' };
    const { body } = render(Page, { props: { data } });
    expect(body).toMatch(/<p[^>]*id="refusal"[^>]*role="alert"[^>]*>refused/u);
    for (const name of ['email', '_password']) {
      expect(body).toMatch(
        new RegExp(
          `<input[^>]*name="${name}"[^>]*aria-invalid="true"[^>]*aria-describedby="refusal"`,
          'u'
        )
      );
    }
  });

  it('can take focus on its heading, where the consent step moves it', () => {
    state.result = undefined;
    const { body } = render(Page, { props: { data } });
    expect(body).toMatch(/<h1[^>]*tabindex="-1"/u);
  });
});
