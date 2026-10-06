import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';

import Page from './+page.svelte';

const state = vi.hoisted((): { result: unknown } => ({ result: undefined }));
const second = vi.hoisted((): { result: unknown } => ({ result: undefined }));

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('#lib/auth/secondFactor.remote.js', async () => ({
  secondFactor: (await import('#testing/remoteFormStub.js')).remoteFormStub(
    second
  )
}));
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

  it('shows the authenticator enrolment as a QR code and as text (§5.2 "Two-factor authentication")', () => {
    state.result = {
      step: 'enrol',
      qrSvg: '<svg data-qr="1"></svg>',
      secret: 'MZXW 6YTB OI',
      passkey: { challenge: 'c' },
      error: null
    };
    second.result = undefined;
    const { body } = render(Page, { props: { data } });
    expect(body).toMatch(
      /role="img"[^>]*aria-label="QR code[^"]*"[^>]*>(?:<!--\w+-->)?<svg data-qr="1">/u
    );
    expect(body).toContain('MZXW 6YTB OI');
    expect(body).toMatch(
      /<input[^>]*autocomplete="one-time-code"[^>]*name="code"/u
    );
    expect(body).not.toContain('name="_password"');
    // A passkey's response is submitted past the code box's `required`.
    expect(body).toMatch(
      /<button[^>]*hidden[^>]*formnovalidate[^>]*name="action"[^>]*value="passkey"/u
    );
    expect(body).toMatch(/<input[^>]*name="passkeyName"/u);
  });

  it('shows a refused code as an alert the code box is described by', () => {
    second.result = { step: 'verify', passkey: null, error: 'wrong' };
    const { body } = render(Page, { props: { data } });
    expect(body).toMatch(
      /<p[^>]*id="code-refusal"[^>]*role="alert"[^>]*>wrong/u
    );
    expect(body).toMatch(
      /<input[^>]*name="code"[^>]*aria-invalid="true"[^>]*aria-describedby="code-refusal"/u
    );
  });

  it('shows the recovery codes once, with a download, behind the saved confirmation', () => {
    second.result = { step: 'recoveryCodes', codes: ['AAAA-BBBB-CCCC-DDDD'] };
    const { body } = render(Page, { props: { data } });
    expect(body).toContain('AAAA-BBBB-CCCC-DDDD</li>');
    expect(body).toMatch(
      /<a[^>]*href="data:text\/plain[^"]*AAAA-BBBB-CCCC-DDDD[^"]*"[^>]*download="recovery-codes.txt"/u
    );
    expect(body).toMatch(/<input type="checkbox" required/u);
    second.result = undefined;
  });
});
