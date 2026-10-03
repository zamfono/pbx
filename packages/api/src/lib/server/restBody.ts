/**
 * Reading a REST request's input (§10.3 conventions): a GET's query string, a JSON body, or a
 * `multipart: true` route's form. Separate from the route table and the handler so each one is
 * read on its own.
 */
import { HTTP_BAD_REQUEST, isRecord } from '@zamfono/shared';

import { OpError } from './ops/types.js';
import type { RouteEntry } from './restRoutes.js';
import { parseQuery, type QueryFieldKinds } from './restTransport.js';

type Fields = Record<string, unknown>;

function parseJsonOrThrow(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OpError(HTTP_BAD_REQUEST, 'invalid JSON body');
  }
}
async function parseJsonBody(request: Request): Promise<Fields> {
  const text = await request.text();
  if (text.length === 0) {
    return {};
  }
  const parsed = parseJsonOrThrow(text);
  if (!isRecord(parsed)) {
    throw new OpError(HTTP_BAD_REQUEST, 'request body must be a JSON object');
  }
  return parsed;
}

/** A `multipart: true` route's file field becomes `{ filename, mimeType, data }` (the shape an operation's upload schema expects, e.g. `audio.create`'s `upload`); every other field stays its text value. */
async function parseMultipart(request: Request): Promise<Fields> {
  const form = await request.formData();
  const entries = await Promise.all(
    [...form.entries()].map(async ([key, value]) => {
      if (typeof value === 'string') {
        return [key, value] as const;
      }
      const data = Buffer.from(await value.arrayBuffer());
      return [
        key,
        { filename: value.name, mimeType: value.type, data }
      ] as const;
    })
  );
  return Object.fromEntries(entries) as Fields;
}
export function readBody(
  request: Request,
  route: RouteEntry,
  queryKinds: QueryFieldKinds
): Promise<Fields> {
  if (route.method === 'GET') {
    return Promise.resolve(parseQuery(request, queryKinds));
  }
  return route.multipart ? parseMultipart(request) : parseJsonBody(request);
}
