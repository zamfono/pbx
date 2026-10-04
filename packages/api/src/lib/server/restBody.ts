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

/** A form's file becomes `{ filename, mimeType, data }`, the shape an operation's upload schema
 *  expects (e.g. `audio.create`'s `upload`); a text field stays its value. */
export async function formValue(value: string | File): Promise<unknown> {
  if (typeof value === 'string') {
    return value;
  }
  const data = Buffer.from(await value.arrayBuffer());
  return { filename: value.name, mimeType: value.type, data };
}

/** A `multipart: true` route's form, each field as `formValue` reads it. */
export async function formFields(form: FormData): Promise<Fields> {
  const entries = await Promise.all(
    [...form.entries()].map(
      async ([key, value]): Promise<[string, unknown]> => [
        key,
        await formValue(value)
      ]
    )
  );
  return Object.fromEntries(entries);
}

export async function readBody(
  request: Request,
  route: RouteEntry,
  queryKinds: QueryFieldKinds
): Promise<Fields> {
  if (route.method === 'GET') {
    return parseQuery(new URL(request.url), queryKinds);
  }
  return route.multipart
    ? formFields(await request.formData())
    : parseJsonBody(request);
}
