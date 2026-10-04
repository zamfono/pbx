/**
 * Reading a request body that is not an audio upload (§10.2 "Greetings and audio"): `api`'s
 * `BODY_SIZE_LIMIT` is sized for uploads, so every JSON or form body `api` reads itself is held
 * to `MAX_BODY_BYTES` here.
 */
import { error } from '@sveltejs/kit';

import { HTTP_CONTENT_TOO_LARGE } from '@zamfono/shared';

import { tryParseJson } from './json.js';

/** The largest body of a request that is not an audio upload: 512 KiB. */
export const MAX_BODY_BYTES = 524_288;

function tooLarge(): never {
  error(HTTP_CONTENT_TOO_LARGE, 'request body too large');
}

/**
 * `request`'s body, refused with 413 past `MAX_BODY_BYTES`: by its `Content-Length` before any
 * of it is read, else as soon as the bytes streamed in pass the limit.
 */
async function readBodyBytes(request: Request): Promise<Buffer> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    tooLarge();
  }
  if (!request.body) {
    return Buffer.alloc(0);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop, by the throw included, cancels the stream.
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** `readBodyBytes` as UTF-8 text. */
export async function readBodyText(request: Request): Promise<string> {
  return (await readBodyBytes(request)).toString('utf8');
}

/** `request`'s JSON body, or `undefined` when it is empty or not valid JSON; 413 as `readBodyBytes`. */
export async function readJsonBody(request: Request): Promise<unknown> {
  return tryParseJson(await readBodyText(request));
}
