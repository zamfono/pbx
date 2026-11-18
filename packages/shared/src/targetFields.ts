/**
 * The forward-target fields that take a template (§9.4 "Templates", §10.3 "Forward targets"): an
 * `external` target's number, a `sip` target's user part, a `webSocket` target's URL and an
 * `extension` target's extension. `api` checks a field's template on write with what is here, and
 * `core` renders it for a call and checks what it rendered to, since a template can render
 * anything: a value that is no number, user part, URL or extension makes the target not work.
 */
import { WEB_SOCKET_URL_MAX_LENGTH } from './columnValues.js';
import { isE164 } from './numbers.js';
import {
  isTemplate,
  renderTemplate,
  templateParts,
  templateProblem,
  type TemplateContext
} from './templates.js';

/**
 * A `sip` target's request-URI user part as written (§9.4 "SIP targets"): RFC 3261's unreserved
 * `.`, `_`, `~`, `-` and the user-unreserved `+` beside letters and digits, a subset that needs no
 * escaping and cannot reach into the `PJSIP/<user>@<endpoint>` dial string; `forward_targets`'
 * CHECK holds the same for one that is no template.
 */
export const SIP_USER_PATTERN = /^[A-Za-z0-9._~+-]{1,64}$/u;
// A rendered user part: the same, and the `%XX` a substituted value's other characters become.
const RENDERED_SIP_USER = /^(?:[A-Za-z0-9._~+-]|%[0-9A-F]{2}){1,64}$/u;
const DIGITS = /^[0-9]+$/u;

/** How each field renders, what its template's literal text may hold, and whether what it
 * rendered to is a value of the field. */
const FIELDS = {
  external: {
    context: 'plain',
    literal: /^[+0-9]*$/u,
    isValid: isE164
  },
  user: {
    context: 'sipUser',
    literal: /^[A-Za-z0-9._~+-]*$/u,
    isValid: (value: string) => RENDERED_SIP_USER.test(value)
  },
  url: {
    context: 'url',
    literal: /^/u,
    isValid: (value: string) =>
      value.length <= WEB_SOCKET_URL_MAX_LENGTH &&
      /^wss?:$/u.test(URL.parse(value)?.protocol ?? '')
  },
  extension: {
    context: 'plain',
    literal: /^[0-9]*$/u,
    isValid: (value: string) => DIGITS.test(value)
  }
} as const satisfies Record<
  string,
  {
    context: TemplateContext;
    literal: RegExp;
    isValid: (value: string) => boolean;
  }
>;
export type TargetField = keyof typeof FIELDS;

/** `source` with each mustache replaced by `x`: a value of the shape the template renders to,
 * for the checks a write makes on its literal text. `null` for no valid template. */
export function templateSample(source: string): string | null {
  return (
    templateParts(source)
      ?.map(part => ('text' in part ? part.text : 'x'))
      .join('') ?? null
  );
}

const AUTHORITY = /^[a-z]+:\/\/(?<authority>[^/?#]*)/u;

/**
 * Why the URL template `source` is refused on write, else `null`: what makes it no template, or a
 * mustache in its scheme, host or port, which are the admin's to name and never a call's value.
 * What it renders to is checked as it is rendered.
 */
export function urlTemplateProblem(source: string): string | null {
  const problem = templateProblem(source);
  if (problem !== null) {
    return problem;
  }
  const authority = AUTHORITY.exec(source)?.groups?.authority;
  return authority === undefined || authority === '' || isTemplate(authority)
    ? 'a placeholder in its scheme, host or port'
    : null;
}

/** Why the template `source` of `field` is refused on write, else `null`: what makes it no
 * template, or literal text the field's value cannot hold. */
export function targetFieldProblem(
  field: TargetField,
  source: string
): string | null {
  if (field === 'url') {
    return urlTemplateProblem(source);
  }
  const problem = templateProblem(source);
  if (problem !== null) {
    return problem;
  }
  const { literal } = FIELDS[field];
  const text = (templateParts(source) ?? [])
    .map(part => ('text' in part ? part.text : ''))
    .join('');
  return literal.test(text) ? null : 'text its value cannot hold';
}

/**
 * `source` rendered with `values` for `field`, each substituted value escaped for it, and whether
 * the result is a value of the field: an E.164 number, a user part, a `ws(s)://` URL, an
 * extension's digits. A source that is no template is returned as it is.
 */
export function renderTargetField(
  field: TargetField,
  source: string,
  values: Readonly<Record<string, unknown>>
): { ok: boolean; value: string } {
  if (!isTemplate(source)) {
    return { ok: true, value: source };
  }
  const { context, isValid } = FIELDS[field];
  const value = renderTemplate(source, values, context) ?? '';
  return { ok: isValid(value), value };
}
