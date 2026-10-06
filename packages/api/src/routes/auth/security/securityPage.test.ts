import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';

import Page from './+page.svelte';

const managed = vi.hoisted((): { result: unknown } => ({ result: undefined }));

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('#lib/auth/secondFactor.remote.js', async () => ({
  secondFactor: (await import('#testing/remoteFormStub.js')).remoteFormStub({
    result: undefined
  })
}));
vi.mock('./security.remote.js', async () => {
  const { remoteFormStub } = await import('#testing/remoteFormStub.js');
  const remover = remoteFormStub({ result: undefined });
  return {
    signIn: remoteFormStub({ result: undefined }),
    manage: remoteFormStub(managed),
    removePasskey: Object.assign(remover, { for: () => remover })
  };
});

const base = {
  dictionary: dictionaryFor('en'),
  companyName: 'Acme',
  sso: null
};

const signedIn = {
  email: 'anna@example.com',
  required: true,
  totp: true,
  passkeys: [
    {
      id: 'p1',
      name: 'Laptop',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: '2026-10-05T09:00:00.000Z'
    }
  ],
  recoveryCodesLeft: 7,
  passkeyOptions: { challenge: 'c' }
};

function bodyFor(manage: typeof signedIn | null): string {
  return render(Page, {
    props: { data: { ...base, manage } as never }
  }).body;
}

describe('the security page (§5.2 "Authentication pages")', () => {
  it('asks for a fresh sign-in without its session', () => {
    const body = bodyFor(null);
    expect(body).toContain('Sign in again to manage');
    expect(body).toMatch(/<input[^>]*name="_password"/u);
  });

  it("lists the signed-in user's methods with their actions", () => {
    managed.result = undefined;
    const body = bodyFor(signedIn);
    expect(body).toContain('anna@example.com');
    expect(body).toContain('Laptop');
    expect(body).toContain('last used 2026-10-05');
    expect(body).toMatch(/name="id"[^>]*value="p1"|value="p1"[^>]*name="id"/u);
    expect(body).toContain('Replace the authenticator app');
    expect(body).toContain('7 unused.');
  });

  it('shows the authenticator a setup is waiting to confirm, and a refusal as an alert', () => {
    managed.result = {
      totpSetup: { qrSvg: '<svg data-qr="1"></svg>', secret: 'MZXW 6YTB OI' },
      codes: null,
      error: 'Incorrect code.'
    };
    const body = bodyFor(signedIn);
    expect(body).toContain('MZXW 6YTB OI');
    expect(body).toMatch(/<p[^>]*role="alert"[^>]*>Incorrect code\./u);
    expect(body).toMatch(/name="action"[^>]*value="totpConfirm"/u);
    managed.result = undefined;
  });
});
