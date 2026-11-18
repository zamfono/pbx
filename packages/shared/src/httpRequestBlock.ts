/**
 * The HTTP request block (§10.6 "HTTP requests"): the request an after-call request and a call
 * flow's HTTP request are configured as, a method, a URL template, headers and an optional body
 * template with its content type. Its validation on write and its rendering for one call live
 * here, beside the one function that sends it (`httpSend.ts`), so `api` and `core` share both.
 */
import { z } from 'zod';

import { httpHeadersSchema, type HttpHeader } from './httpHeaders.js';
import {
  HTTP_METHODS,
  sendsBody,
  type HttpMethod,
  type HttpSend
} from './httpSend.js';
import { urlLiteralProblem } from './outboundTargets.js';
import { templateSample, urlTemplateProblem } from './targetFields.js';
import {
  isTemplate,
  renderTemplate,
  type TemplateContext
} from './templates.js';
import { templateProblem } from './templateSyntax.js';

/** The content types a body template may have, each with how a substituted value is escaped. */
const BODY_CONTEXTS = {
  'application/json': 'json',
  'application/x-www-form-urlencoded': 'form',
  'text/plain': 'line'
} as const satisfies Record<string, TemplateContext>;
export type HttpContentType = keyof typeof BODY_CONTEXTS;
export const HTTP_CONTENT_TYPES = Object.keys(
  BODY_CONTEXTS
) as HttpContentType[];

const HTTP_URL = /^https?:$/u;

/** Why `url`, a URL or a template of one, is refused on write, else `null`: no `http(s)` URL once
 * each placeholder is filled in, a placeholder in its scheme, host or port, or an address no
 * request could reach (§3.1 "Outbound targets"). */
export function requestUrlProblem(url: string): string | null {
  const problem = isTemplate(url) ? urlTemplateProblem(url) : null;
  if (problem !== null) {
    return problem;
  }
  const sample = templateSample(url) ?? url;
  return HTTP_URL.test(URL.parse(sample)?.protocol ?? '')
    ? urlLiteralProblem(sample)
    : 'no http:// or https:// URL';
}

/** The block's fields as a write gives them, for a schema that adds its own beside them. */
export const httpRequestFields = {
  method: z
    .enum(HTTP_METHODS)
    .default('POST')
    .describe('GET, POST, PUT, PATCH or DELETE; GET and DELETE send no body.'),
  url: z
    .string()
    .superRefine((url, ctx) => {
      const problem = requestUrlProblem(url);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', message: `url has ${problem}` });
      }
    })
    .describe(
      'The URL, https://, or http:// for a receiver on a private network; past the host it may be a template, each value escaped as a URL component (see zamfono.help templates).'
    ),
  headers: httpHeadersSchema({ templates: true })
    .default([])
    .describe('Custom headers, such as Authorization; replaced as a whole.'),
  body: z
    .string()
    .superRefine((body, ctx) => {
      const problem = templateProblem(body);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', message: `body has ${problem}` });
      }
    })
    .nullable()
    .default(null)
    .describe(
      'The body as a template, each value escaped for contentType; null sends the default body, or none.'
    ),
  contentType: z
    .enum(HTTP_CONTENT_TYPES)
    .nullable()
    .default(null)
    .describe(
      'The type of body: application/json (values escaped as JSON strings), application/x-www-form-urlencoded (form-encoded) or text/plain (control characters stripped); null without a body.'
    )
};

/** A block's fields as parsed. */
export type HttpRequestInput = {
  method: HttpMethod;
  url: string;
  body: string | null;
  contentType: HttpContentType | null;
};

/** What a write refuses of a block as a whole, by the field it names: a body without its
 * content type or the reverse, and a body on a method that sends none. */
export function requestBlockIssues(
  request: HttpRequestInput
): { path: string; message: string }[] {
  if ((request.body === null) !== (request.contentType === null)) {
    return [
      { path: 'contentType', message: 'body and contentType go together' }
    ];
  }
  return request.body !== null && !sendsBody(request.method)
    ? [{ path: 'body', message: `a ${request.method} request sends no body` }]
    : [];
}

/** The templates of a block, for the check of the names they read. */
export function requestTemplates(request: {
  url: string;
  headers: readonly { value?: string }[];
  body: string | null;
}): string[] {
  return [
    request.url,
    ...request.headers.flatMap(header =>
      header.value === undefined ? [] : [header.value]
    ),
    ...(request.body === null ? [] : [request.body])
  ];
}

/** A block as stored, its secrets decrypted: what one request is rendered from. */
export type StoredRequest = HttpRequestInput & {
  headers: HttpHeader[];
  secret: string | null;
};

/** The reason a request whose URL template rendered no URL fails for. */
export const INVALID_URL_REASON = 'invalid URL';

/**
 * `request` rendered with `values` for one send (§10.6 "HTTP requests"): the URL with each value
 * escaped as a URL component, each header's value without control characters, trimmed, an empty
 * one left out, and the body with each value escaped for its content type; `defaultBody` stands
 * in for a block without a body, as JSON. `null` when the URL rendered is no `http(s)` URL.
 */
export function renderRequest(
  request: StoredRequest,
  values: Readonly<Record<string, unknown>>,
  defaultBody?: string
): Pick<
  HttpSend,
  'method' | 'url' | 'headers' | 'body' | 'contentType' | 'secret'
> | null {
  const url = renderTemplate(request.url, values, 'url') ?? '';
  if (!HTTP_URL.test(URL.parse(url)?.protocol ?? '')) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const header of request.headers) {
    const value = (renderTemplate(header.value, values, 'line') ?? '').trim();
    if (value !== '') {
      headers[header.name] = value;
    }
  }
  const body =
    request.body === null || request.contentType === null
      ? null
      : {
          body:
            renderTemplate(
              request.body,
              values,
              BODY_CONTEXTS[request.contentType]
            ) ?? '',
          contentType: request.contentType
        };
  return {
    method: request.method,
    url,
    headers,
    secret: request.secret,
    ...(body ??
      (defaultBody === undefined
        ? {}
        : { body: defaultBody, contentType: 'application/json' }))
  };
}
