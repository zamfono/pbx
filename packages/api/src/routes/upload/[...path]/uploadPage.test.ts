import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';

import Page from './+page.svelte';

const state = vi.hoisted(() => ({
  url: new URL('https://pbx.example/upload/audio')
}));

vi.mock('$app/state', () => ({ page: state }));

// The form's attributes as SvelteKit's would spread them, with `fields` kept out of the spread.
vi.mock('./upload.remote.js', () => {
  const field = (name: string) => ({
    as: (type: string, value?: string) => ({ name, type, value })
  });
  const upload = { method: 'POST', action: '?/remote=abc123/upload' };
  Object.defineProperties(upload, {
    result: { value: { refusal: 'refused' } },
    pending: { value: 0 },
    fields: { value: { link: field('link'), upload: field('upload') } }
  });
  return { upload };
});

describe('the upload page (§10.5 "Uploads")', () => {
  // Without JavaScript a refusal re-renders the page at the form's own POST URL, whose query
  // carries SvelteKit's `/remote` action parameter.
  it('submits the link it was opened at when re-rendered after a refusal without JavaScript', () => {
    const query = 'kind=moh&label=Hold&access_token=abc.def.ghi';
    state.url = new URL(
      `https://pbx.example/upload/audio?${query}&%2Fremote=abc123%2Fupload`
    );
    const { body } = render(Page, {
      props: {
        data: {
          dictionary: dictionaryFor('en'),
          companyName: 'Acme',
          live: true
        }
      }
    });
    expect(body).toContain(
      `value="/upload/audio?${query.replaceAll('&', '&amp;')}"`
    );
  });
});
