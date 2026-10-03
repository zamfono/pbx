import { HTTP_OK } from '@zamfono/shared';

import { ACCESS_TOKEN_PARAM } from './auth/bearer.js';
import { BinaryResult } from './binaryResult.js';
import type { JsonSchema } from './ops/publishedSchema.js';

type QueryFieldKind = 'number' | 'boolean';
export type QueryFieldKinds = Map<string, QueryFieldKind>;

/** The JSON-Schema `type`(s) declared for one of `schema`'s own properties, as a `Set` for a quick `has`. */
function jsonSchemaTypes(propertySchema: JsonSchema): Set<string> {
  const { type } = propertySchema;
  if (Array.isArray(type)) {
    return new Set(
      type.filter((entry): entry is string => typeof entry === 'string')
    );
  }
  return new Set(typeof type === 'string' ? [type] : []);
}

/**
 * The declared type per top-level field of an operation's input JSON Schema — `number` for
 * `number`/`integer`, `boolean` for `boolean`, absent for everything else (including `string`,
 * which is left alone so a digits-only filter like `search.query`'s `q` is never guessed into a
 * number, §10.3).
 */
export function queryFieldKinds(schema: JsonSchema): QueryFieldKinds {
  const kinds: QueryFieldKinds = new Map();
  const properties =
    (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const types = jsonSchemaTypes(propertySchema);
    if (types.has('number') || types.has('integer')) {
      kinds.set(name, 'number');
    } else if (types.has('boolean')) {
      kinds.set(name, 'boolean');
    }
  }
  return kinds;
}

/** Converts a raw query string to the operation's declared `number`/`boolean` type; an unparsable value is left as text, so the operation's own validation reports it. */
function coerceTyped(
  raw: string,
  kind: QueryFieldKind
): string | number | boolean {
  if (kind === 'boolean') {
    return raw === 'true' || raw === 'false' ? raw === 'true' : raw;
  }
  return raw === '' ? raw : Number(raw);
}

/** Query values are coerced only where the matched operation's own schema says `number`/`boolean` (§10.3); every other value, `cursor` included, stays the wire string. A download link's `access_token` authenticates the request (`bearer.ts`) and is no input. */
export function parseQuery(
  request: Request,
  kinds: QueryFieldKinds
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (key === ACCESS_TOKEN_PARAM) {
      continue;
    }
    const kind = kinds.get(key);
    out[key] = kind ? coerceTyped(value, kind) : value;
  }
  return out;
}

/** An operation's binary result (§10.3 `voicemails.audio`/`recordings.audio`): raw bytes plus the wire content type. */
// `Buffer`/`Uint8Array` is typed over `ArrayBufferLike` (it may back onto a `SharedArrayBuffer`);
// `Response`'s body type wants one backed by a plain `ArrayBuffer`, so the bytes are copied into a
// fresh view rather than passed straight through.
function toResponseBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** Escapes a filename for the `content-disposition` quoted-string (RFC 6266 / RFC 2616 §2.2) and strips CR/LF, which `Response` would otherwise reject as a header-value character. */
function quoteFilename(filename: string): string {
  return filename
    .replace(/[\r\n]/gu, '')
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"');
}

/** Every operation's result is JSON, except a `BinaryResult`, answered as its own bytes so a download route never gets JSON-wrapped. */
export async function outputResponse(output: unknown): Promise<Response> {
  if (output instanceof BinaryResult) {
    return new Response(toResponseBody(await output.read()), {
      status: HTTP_OK,
      headers: {
        'content-type': output.contentType,
        'content-disposition': `attachment; filename="${quoteFilename(output.filename)}"`
      }
    });
  }
  return new Response(JSON.stringify(output), {
    status: HTTP_OK,
    headers: { 'content-type': 'application/json' }
  });
}
