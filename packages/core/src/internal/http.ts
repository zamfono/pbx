/**
 * The internal API's request and response plumbing (§3.1): JSON answers, RFC 9457 problems for
 * every error, and the one body reader with its size limit.
 */
import type http from 'node:http';

import {
  HTTP_BAD_REQUEST,
  HTTP_CONTENT_TOO_LARGE,
  PROBLEM_CONTENT_TYPE
} from '@zamfono/shared';

// Bodies are a short list of reload kinds or a few ids and a dial string; this only bounds a
// request from the internal network's one client (§3.1), not a size any real body approaches.
export const MAX_INTERNAL_BODY_BYTES = 65536;

export function respondJson(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** An RFC 9457 problem, the shape `api` answers its own errors in (§10.3). `detail` names the
 * cause of a refused call action (§10.2 `noRegisteredDevice`), which `api`'s core client reads
 * back; every other error carries none. */
export function respondProblem(
  response: http.ServerResponse,
  status: number,
  title: string,
  detail?: string
): void {
  response.writeHead(status, { 'Content-Type': PROBLEM_CONTENT_TYPE });
  response.end(JSON.stringify({ type: 'about:blank', title, status, detail }));
}

/** Answers a body its route cannot act on with 400. */
export function respondInvalidBody(response: http.ServerResponse): void {
  respondProblem(response, HTTP_BAD_REQUEST, 'invalid body');
}

/** The request's raw body, `null` past `MAX_INTERNAL_BODY_BYTES`. */
function readBodyText(request: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      // Past the limit, keep draining so 'end' still fires and a response can be written on this
      // connection, but stop buffering.
      if (receivedBytes <= MAX_INTERNAL_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      resolve(
        receivedBytes > MAX_INTERNAL_BODY_BYTES
          ? null
          : Buffer.concat(chunks).toString('utf8')
      );
    });
    request.on('error', reject);
  });
}

/**
 * The request's JSON body, `undefined` for an empty one; `null` once it has answered the request
 * itself, 413 past `MAX_INTERNAL_BODY_BYTES` and 400 for malformed JSON.
 */
export async function readJsonBody(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<{ body: unknown } | null> {
  const text = await readBodyText(request);
  if (text === null) {
    respondProblem(response, HTTP_CONTENT_TOO_LARGE, 'body too large');
    return null;
  }
  if (text === '') {
    return { body: undefined };
  }
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    respondInvalidBody(response);
    return null;
  }
}
