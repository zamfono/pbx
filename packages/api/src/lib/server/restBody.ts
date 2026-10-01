/**
 * Reading a REST request's input (§10.3 conventions): a GET's query string, a JSON body, or a
 * `multipart: true` route's form. Separate from the route table and the handler so each one is
 * read on its own.
 */
import type { z } from 'zod';

import { OpError } from './ops/types.js';
import type { RouteEntry } from './restRoutes.js';
import { parseQuery } from './restTransport.js';

type Fields = Record<string, unknown>;

const BAD_REQUEST_STATUS = 400;

function parseJsonOrThrow(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OpError(BAD_REQUEST_STATUS, 'invalid JSON body');
  }
}
async function parseJsonBody(request: Request): Promise<Fields> {
  const text = await request.text();
  if (text.length === 0) {
    return {};
  }
  const parsed = parseJsonOrThrow(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OpError(BAD_REQUEST_STATUS, 'request body must be a JSON object');
  }
  return parsed as Fields;
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
  input: z.ZodType
): Promise<Fields> {
  if (route.method === 'GET') {
    return Promise.resolve(parseQuery(request, input));
  }
  return route.multipart ? parseMultipart(request) : parseJsonBody(request);
}
