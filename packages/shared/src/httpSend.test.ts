import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { errorReason, sendHttpRequest, type HttpSend } from './httpSend.js';

// §10.6: the one function that sends an HTTP request an admin configured.

type Seen = {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

describe('sendHttpRequest', () => {
  let server: http.Server;
  let url: string;
  let seen: Seen[];
  let answer: { status: number; headers: Record<string, string>; body: string };

  beforeEach(async () => {
    seen = [];
    answer = { status: 200, headers: {}, body: '{"ok":true}' };
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
        res.writeHead(answer.status, answer.headers).end(answer.body);
      });
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/x`;
  });

  afterEach(async () => {
    await new Promise(resolve => {
      server.close(resolve);
    });
  });

  const send = (over: Partial<HttpSend> = {}) =>
    sendHttpRequest({
      method: 'POST',
      url,
      headers: {},
      timeoutMs: 2000,
      policy: null,
      ...over
    });

  it('sends the method, headers and body, signed under the secret', async () => {
    const answered = await send({
      method: 'PUT',
      headers: { Authorization: 'Bearer t' },
      body: 'a=1',
      contentType: 'application/x-www-form-urlencoded',
      secret: 's3cret'
    });
    expect(answered).toEqual({ status: 200, body: null });
    expect(seen).toMatchObject([
      {
        method: 'PUT',
        body: 'a=1',
        headers: {
          authorization: 'Bearer t',
          'content-type': 'application/x-www-form-urlencoded',
          'x-zamfono-signature': createHmac('sha256', 's3cret')
            .update('a=1')
            .digest('hex')
        }
      }
    ]);
  });

  it('sends no body with GET and DELETE, the signature being that of none', async () => {
    await send({ method: 'GET', body: 'ignored', contentType: 'text/plain' });
    await send({ method: 'DELETE', secret: 's3cret' });
    expect(seen.map(request => request.body)).toEqual(['', '']);
    expect(seen[0]?.headers['content-type']).toBeUndefined();
    expect(seen[1]?.headers['x-zamfono-signature']).toBe(
      createHmac('sha256', 's3cret').update('').digest('hex')
    );
  });

  it('reads the response up to a limit where asked, and fails a larger one', async () => {
    expect(await send({ maxResponseBytes: 64 })).toEqual({
      status: 200,
      body: '{"ok":true}'
    });
    answer.body = 'x'.repeat(65);
    const failed = await send({ maxResponseBytes: 64 }).catch(
      (error: unknown) => error
    );
    expect(errorReason(failed)).toBe('response too large');
  });

  it('follows no redirect: a 3xx is the answer', async () => {
    answer = {
      status: 307,
      headers: { location: `${url}/elsewhere` },
      body: ''
    };
    expect((await send()).status).toBe(307);
    expect(seen).toHaveLength(1);
  });

  it('refuses an address the policy does, and plain HTTP to a public one, before connecting', async () => {
    const policy = { allowPrivate: true, ownSubnets: [] };
    expect(
      errorReason(await send({ policy }).catch((error: unknown) => error))
    ).toBe('forbidden address');
    expect(
      errorReason(
        await send({ policy, url: 'http://203.0.113.7/x' }).catch(
          (error: unknown) => error
        )
      )
    ).toBe('plain HTTP to a public address');
    expect(seen).toEqual([]);
  });

  it('names a timeout and a refused connection', async () => {
    server.removeAllListeners('request');
    expect(
      errorReason(
        await send({ timeoutMs: 50 }).catch((error: unknown) => error)
      )
    ).toBe('timeout');
    expect(
      errorReason(
        await send({ url: 'http://127.0.0.1:1/x' }).catch(
          (error: unknown) => error
        )
      )
    ).toBe('connection refused');
  });
});
