/**
 * The custom headers of an HTTP request the stack sends (§10.6 "Request headers"): a webhook's,
 * an after-call request's and a call flow's HTTP request's. They mirror a `sip` target's custom
 * headers (§9.4 "Header templates") where HTTP forces no difference: any field name but the
 * ones the client sets itself, no cap per value, and a `secret` flag for a value that is a
 * credential, stored encrypted and never read back.
 */
import { z } from 'zod';

import { lineTemplateProblem, utf8Bytes } from './sipHeaders.js';
import { isTemplate } from './templates.js';

/** An HTTP field name: an RFC 9110 `token` of 1 to 64 characters. */
export const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/u;

/** The fields a request's sender sets itself, and the signature (§10.6): no custom header may
 * name one, in any case. */
export const RESERVED_HTTP_HEADERS: readonly string[] = [
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'x-zamfono-signature'
];

/** The most bytes a request's headers may take as written: the common receiver limit (nginx's
 * 8k header buffers). */
export const HTTP_HEADERS_MAX_BYTES = 8192;

/** A header as a write gives it: a `secret` one may leave its value out to keep the stored
 * one, and may carry the `secretSet` a read returned it with, which a write ignores. */
export type HttpHeaderInput = {
  name: string;
  value?: string | undefined;
  secret: boolean;
  secretSet?: true | undefined;
};

/** A header as a row's `headers_json` holds it: a secret one without its value, which the row's
 * `secret_headers_enc` keeps by the header's lower-case name. */
export type StoredHttpHeader =
  { name: string; value: string } | { name: string; secret: true };

/** A header with its value, as a request sends it once rendered. */
export type HttpHeader = { name: string; value: string };

/** `: ` between a header's name and its value. */
const SEPARATOR_BYTES = 2;

/** How many bytes `headers` take as written: per header its name, 2 for `: ` and its value. */
export function httpHeadersSize(headers: readonly HttpHeader[]): number {
  return headers.reduce(
    (sum, header) =>
      sum + header.name.length + SEPARATOR_BYTES + utf8Bytes(header.value),
    0
  );
}

/**
 * The schema of a request's `headers` on write. With `templates`, a value is a template of the
 * call's values (§9.4 "Templates"); without, literal text, a `{{` refused rather than sent as
 * written, since the request belongs to no call. Names are unique without case; the size and a
 * secret value left out are checked against the stored row (`api`).
 */
export function httpHeadersSchema(options: {
  templates: boolean;
}): z.ZodType<HttpHeaderInput[]> {
  const header = z.strictObject({
    name: z
      .string()
      .regex(HTTP_HEADER_NAME_PATTERN, 'name must be an HTTP field name')
      .refine(
        name => !RESERVED_HTTP_HEADERS.includes(name.toLowerCase()),
        'name is a header the request sets itself'
      )
      .describe(
        'The header name, such as Authorization; not Host, Content-Type, Content-Length or another header the request sets itself, nor X-Zamfono-Signature.'
      ),
    value: z
      .string()
      .superRefine((value, ctx) => {
        const problem =
          !options.templates && isTemplate(value)
            ? 'a {{placeholder}}, which this header does not take'
            : lineTemplateProblem(value);
        if (problem !== null) {
          ctx.addIssue({ code: 'custom', message: `value has ${problem}` });
        }
      })
      .optional()
      .describe(
        options.templates
          ? 'The value, literal text with {{placeholder}} substitutions (see zamfono.help templates); only a secret header may leave it out, which keeps the stored value.'
          : 'The value, literal text; only a secret header may leave it out, which keeps the stored value.'
      ),
    secret: z
      .boolean()
      .default(false)
      .describe(
        'Whether the value is a credential: stored encrypted and never read back, only secretSet.'
      ),
    secretSet: z
      .literal(true)
      .optional()
      .describe(
        'Set on a secret header as a read returns it; ignored on a write.'
      )
  });
  return z.array(header).superRefine((headers, ctx) => {
    const seen = new Set<string>();
    for (const [index, { name, value, secret }] of headers.entries()) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `header ${name} is given twice`
        });
      }
      seen.add(key);
      if (value === undefined && !secret) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'value'],
          message: 'a header that is no secret needs its value'
        });
      }
    }
  });
}

/** A header as a read returns it: a secret one as `secretSet`, without its value. */
export const httpHeaderWire = z.object({
  name: z.string(),
  value: z.string().optional(),
  secret: z.boolean(),
  secretSet: z
    .literal(true)
    .optional()
    .describe('On a secret header: its value is set, and write-only.')
});
export type HttpHeaderWire = z.infer<typeof httpHeaderWire>;

const storedHeader = z.union([
  z.object({ name: z.string(), value: z.string() }),
  z.object({ name: z.string(), secret: z.literal(true) })
]);

/** `headers_json` decoded. */
export function decodeStoredHeaders(json: string): StoredHttpHeader[] {
  return z.array(storedHeader).parse(JSON.parse(json));
}

/** `headers_json` as a read returns it. */
export function wireHeaders(json: string): HttpHeaderWire[] {
  return decodeStoredHeaders(json).map(header =>
    'value' in header
      ? { name: header.name, value: header.value, secret: false }
      : { name: header.name, secret: true, secretSet: true }
  );
}
