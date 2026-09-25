import http from 'node:http';
import { describe, expect, it } from 'vitest';

import type { MailRequest } from '@zamfono/shared';

import { ApiClient } from './apiClient.js';

type StubRequest = {
  path: string;
  contentType: string | undefined;
  body: string;
};

/** A local HTTP receiver that records every POST and answers with `status`. */
function startStub(status: number): Promise<{
  url: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}> {
  const requests: StubRequest[] = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        requests.push({
          path: req.url ?? '',
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8')
        });
        res.writeHead(status);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise(closed => {
            server.close(() => {
              closed();
            });
          })
      });
    });
  });
}

const sampleRequest: MailRequest = {
  kind: 'missedCall',
  to: { userId: 'u1' },
  values: {
    callerNumber: '+15551234',
    callerName: '',
    receivedAt: '2024-01-01T00:00:00.000Z',
    didLabel: 'Main'
  }
};

describe('ApiClient', () => {
  it('POSTs the mail request as JSON to /internal/mail', async () => {
    const stub = await startStub(202);
    try {
      await new ApiClient(stub.url).mail(sampleRequest);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.path).toBe('/internal/mail');
      expect(stub.requests[0]?.contentType).toBe('application/json');
      expect(JSON.parse(stub.requests[0]?.body ?? '')).toEqual(sampleRequest);
    } finally {
      await stub.close();
    }
  });

  it('throws when api answers with a non-2xx status', async () => {
    const stub = await startStub(500);
    try {
      await expect(
        new ApiClient(stub.url).mail(sampleRequest)
      ).rejects.toThrow();
    } finally {
      await stub.close();
    }
  });
});
