import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

import { dictionaryFor } from '#lib/i18n/index.js';

import ErrorPage from './+error.svelte';

const dict = dictionaryFor('de');

const state = vi.hoisted(() => ({
  route: { id: null as string | null },
  data: {}
}));

vi.mock('$app/state', () => ({ page: state }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

function bodyFor(routeId: string | null): string {
  state.route = { id: routeId };
  state.data = { dictionary: dict, companyName: 'Acme' };
  return render(ErrorPage).body;
}

describe('the error boundary', () => {
  it('reports a sign-in problem on the authentication pages', () => {
    const body = bodyFor('/auth/forgot');
    expect(body).toContain(dict.error.title);
    expect(body).toContain(dict.error.generic);
    expect(body).toContain(dict.error.backToLogin);
  });

  it('says an upload failed, and what an upload may be, on the upload page', () => {
    const body = bodyFor('/upload/[...path]');
    expect(body).toContain(dict.upload.title);
    expect(body).toContain(dict.upload.error);
    expect(body).not.toContain(dict.error.title);
  });

  it('shows a generic text, with no sign-in link, for a page no route serves', () => {
    const body = bodyFor(null);
    expect(body).toContain(dict.error.unavailableTitle);
    expect(body).toContain(dict.error.unavailable);
    expect(body).not.toContain(dict.error.backToLogin);
  });
});
