import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { crossSiteFormRejection } from './crossSiteForms.js';

process.env.ORIGIN = 'https://pbx.example.com';

const STATUS_FORBIDDEN = 403;

function post(url: string, contentType: string, origin?: string): Request {
  const headers = new Headers({ 'content-type': contentType });
  if (origin !== undefined) {
    headers.set('origin', origin);
  }
  return new Request(url, { method: 'POST', headers, body: '' });
}

// The two ways a remote `form` submits (§5.2 "Authentication pages"): without JavaScript the
// browser posts the form itself to the page's own URL with a `?/remote=` action; with it,
// SvelteKit posts its own encoding to `/_app/remote/<id>`.
const SUBMISSIONS = [
  {
    name: 'a no-JavaScript forgot-password submission',
    url: 'https://pbx.example.com/auth/forgot?/remote=abc/requestReset',
    type: 'application/x-www-form-urlencoded'
  },
  {
    name: 'a no-JavaScript set-password submission',
    url: 'https://pbx.example.com/auth/set-password?token=t&/remote=abc/setPassword',
    type: 'multipart/form-data; boundary=x'
  },
  {
    name: 'an enhanced remote-form submission',
    url: 'https://pbx.example.com/_app/remote/abc/requestReset',
    type: 'application/x-sveltekit-formdata'
  }
];

describe('crossSiteFormRejection', () => {
  for (const { name, url, type } of SUBMISSIONS) {
    it(`refuses ${name} from another origin or with none`, () => {
      const pathname = new URL(url).pathname;
      expect(
        crossSiteFormRejection(
          post(url, type, 'https://evil.example'),
          pathname
        )?.status
      ).toBe(STATUS_FORBIDDEN);
      expect(crossSiteFormRejection(post(url, type), pathname)?.status).toBe(
        STATUS_FORBIDDEN
      );
    });

    it(`lets ${name} from the stack's own origin through`, () => {
      const pathname = new URL(url).pathname;
      expect(
        crossSiteFormRejection(
          post(url, type, 'https://pbx.example.com'),
          pathname
        )
      ).toBeNull();
    });
  }

  it("leaves the proxy hook's origin-less form POST to /internal through", () => {
    const url = 'http://api:3000/internal/certificate';
    expect(
      crossSiteFormRejection(
        post(url, 'application/x-www-form-urlencoded'),
        '/internal/certificate'
      )
    ).toBeNull();
  });

  it('leaves the JSON REST endpoints to API clients without an Origin', () => {
    const url = 'https://pbx.example.com/auth/resetRequest';
    expect(
      crossSiteFormRejection(
        post(url, 'application/json'),
        '/auth/resetRequest'
      )
    ).toBeNull();
  });
});
