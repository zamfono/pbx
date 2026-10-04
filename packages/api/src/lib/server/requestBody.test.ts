import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES, readBodyText } from './requestBody.js';

const CHUNK_BYTES = 65_536;

function post(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
): Request {
  return new Request('http://api/', {
    method: 'POST',
    headers,
    body,
    duplex: 'half'
  } as RequestInit);
}

async function refusal(read: Promise<unknown>): Promise<unknown> {
  return read.then(
    () => null,
    (error: unknown) => error
  );
}

describe('readBodyText', () => {
  it('refuses a body whose Content-Length is over the limit with 413, before reading it', async () => {
    let read = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          read = true;
        }
      },
      { highWaterMark: 0 }
    );
    const error = await refusal(
      readBodyText(post(body, { 'content-length': String(MAX_BODY_BYTES + 1) }))
    );
    expect(isHttpError(error, 413)).toBe(true);
    expect(read).toBe(false);
  });

  it('refuses a chunked body with 413 once its bytes pass the limit, reading no further', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: controller => {
          pulled += 1;
          controller.enqueue(new Uint8Array(CHUNK_BYTES));
        }
      },
      { highWaterMark: 0 }
    );
    const error = await refusal(readBodyText(post(body)));
    expect(isHttpError(error, 413)).toBe(true);
    expect(pulled * CHUNK_BYTES).toBeLessThanOrEqual(
      MAX_BODY_BYTES + 2 * CHUNK_BYTES
    );
  });

  it('reads a body within the limit', async () => {
    const request = new Request('http://api/', {
      method: 'POST',
      body: '{"a":1}'
    });
    expect(await readBodyText(request)).toBe('{"a":1}');
  });
});
