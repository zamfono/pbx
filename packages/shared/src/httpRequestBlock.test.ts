import { describe, expect, it } from 'vitest';

import {
  renderRequest,
  requestBlockIssues,
  requestUrlProblem,
  type StoredRequest
} from './httpRequestBlock.js';

// §10.6 "HTTP requests": the request block's validation and rendering.

const REQUEST: StoredRequest = {
  method: 'POST',
  url: 'https://crm.example/calls/{{callId}}?from={{callerNumber}}',
  headers: [
    { name: 'Authorization', value: 'Bearer tok' },
    { name: 'X-Caller', value: ' {{callerName}} ' },
    { name: 'X-None', value: '{{crm.missing}}' }
  ],
  body: null,
  contentType: null,
  secret: 'sign-me'
};
const VALUES = {
  callId: 'c 1',
  callerNumber: '+43 660',
  callerName: 'Eve "E"\r\nX-Injected: 1',
  crm: { tier: 'a&b=c' }
};

describe('renderRequest', () => {
  it('escapes the URL per component and strips control characters from header values', () => {
    expect(renderRequest(REQUEST, VALUES)).toEqual({
      method: 'POST',
      url: 'https://crm.example/calls/c%201?from=%2B43%20660',
      headers: {
        Authorization: 'Bearer tok',
        'X-Caller': 'Eve "E"X-Injected: 1'
      },
      secret: 'sign-me'
    });
  });

  it('escapes a body for its content type', () => {
    const body = (
      contentType: StoredRequest['contentType'],
      template: string
    ) => renderRequest({ ...REQUEST, body: template, contentType }, VALUES);
    const json = body('application/json', '{"name":"{{callerName}}"}');
    expect(json).toMatchObject({ contentType: 'application/json' });
    expect(JSON.parse(json?.body ?? '')).toEqual({ name: VALUES.callerName });
    expect(
      body(
        'application/x-www-form-urlencoded',
        'tier={{crm.tier}}&n={{callerNumber}}'
      )?.body
    ).toBe('tier=a%26b%3Dc&n=%2B43+660');
    expect(body('text/plain', 'from {{callerName}}')?.body).toBe(
      'from Eve "E"X-Injected: 1'
    );
  });

  it('sends the default body as JSON for a block without one, and none without either', () => {
    expect(renderRequest(REQUEST, VALUES, '{"id":1}')).toMatchObject({
      body: '{"id":1}',
      contentType: 'application/json'
    });
    expect(renderRequest(REQUEST, VALUES)).not.toHaveProperty('body');
  });

  it('answers null for a URL template that renders no http(s) URL', () => {
    expect(renderRequest({ ...REQUEST, url: '{{callId}}' }, VALUES)).toBeNull();
  });
});

describe('on write', () => {
  it('takes an http(s) URL whose scheme, host and port are literal', () => {
    for (const url of [
      'https://crm.example/a',
      'https://crm.example:8443/{{callId}}?x={{did}}',
      'http://10.0.0.5/hook',
      'http://receiver.lan/{{did}}'
    ]) {
      expect(requestUrlProblem(url), url).toBeNull();
    }
    const refused = {
      'wss://crm.example/a': /no http/u,
      '{{did}}': /scheme, host or port/u,
      'https://{{did}}/a': /scheme, host or port/u,
      'http://203.0.113.7/{{did}}': /private address/u,
      'http://127.0.0.1/a': /loopback/u,
      'https://crm.example/{{slice did}}': /wrong number/u
    };
    for (const [url, reason] of Object.entries(refused)) {
      expect(requestUrlProblem(url) ?? '', url).toMatch(reason);
    }
  });

  it('pairs a body with its content type, and refuses one on GET and DELETE', () => {
    const issues = (request: Partial<StoredRequest>) =>
      requestBlockIssues({ ...REQUEST, ...request }).map(issue => issue.path);
    expect(issues({})).toEqual([]);
    expect(issues({ body: 'x', contentType: 'text/plain' })).toEqual([]);
    expect(issues({ body: 'x' })).toEqual(['contentType']);
    expect(issues({ contentType: 'text/plain' })).toEqual(['contentType']);
    expect(
      issues({ method: 'DELETE', body: 'x', contentType: 'text/plain' })
    ).toEqual(['body']);
  });
});
