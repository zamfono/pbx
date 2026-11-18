/**
 * A `sip` forward target's custom headers (§9.4 "Header templates", §10.3 "Forward targets"): the
 * call's placeholders, which every template of a call may name (§9.4 "Templates"), each with the
 * most bytes it renders to in a SIP header, and the headers' validation and rendering. `api`
 * validates a target's headers on write and `core` renders them at the originate, with the one
 * renderer (`templates.ts`), so the two cannot disagree on what a value means.
 */
import { renderTemplate, templateParts, templateProblem } from './templates.js';

/** Each placeholder and the most UTF-8 bytes its value renders to; `core` cuts a longer one. */
export const SIP_HEADER_PLACEHOLDERS = {
  callerNumber: 32,
  callerName: 64,
  did: 16,
  calledExtension: 16,
  calledName: 64,
  forwardedByExtension: 16,
  forwardedByName: 64,
  forwardReason: 13,
  hopCount: 2,
  callId: 36,
  direction: 8,
  language: 2,
  startedAt: 24
} as const;

export type SipHeaderPlaceholder = keyof typeof SIP_HEADER_PLACEHOLDERS;

/** Every placeholder's value for one call, as its templates read them (§9.4 "Templates"). */
export type CallValues = Record<SipHeaderPlaceholder, string>;

/** Whether `name` is one of the call's placeholders. */
export function isCallPlaceholder(name: string): name is SipHeaderPlaceholder {
  return Object.hasOwn(SIP_HEADER_PLACEHOLDERS, name);
}

/** A header as a target stores it: a name and a value template. */
export type SipHeaderTemplate = { name: string; value: string };

/** `X-`, in any case, and 1 to 64 of `A-Z a-z 0-9 -`: a name that needs no quoting and cannot
 * collide with a header SIP itself defines. */
export const SIP_HEADER_NAME_PATTERN = /^[Xx]-[A-Za-z0-9-]{1,64}$/u;

/** The most bytes one header's value renders to, whatever its placeholders. */
export const SIP_HEADER_VALUE_MAX_BYTES = 256;

/** The most bytes a target's headers may take by `sipHeadersSize`. */
export const SIP_HEADERS_MAX_BYTES = 2048;

/** The headers a `sip` target written without any gets: the original caller and the DID. */
export const DEFAULT_SIP_HEADERS: readonly SipHeaderTemplate[] = [
  { name: 'X-Zamfono-Caller', value: '{{callerNumber}}' },
  { name: 'X-Zamfono-Did', value: '{{did}}' }
];

const CONTROL = /\p{Cc}/u;
const EVERY_CONTROL = /\p{Cc}/gu;
const utf8 = new TextEncoder();

/** `text`'s length in bytes of UTF-8, the unit every size here is in. */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/** `text` cut to at most `maxBytes` bytes of UTF-8, never inside a character. */
export function cutUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * Why `value` is no header value, as a write refuses it, else `null` (§9.4 "Header templates"): a
 * control character, which could end the header, or what makes it no template (`templateProblem`),
 * a name `isName` does not take among them (left out, any name).
 */
export function lineTemplateProblem(
  value: string,
  isName?: (name: string) => boolean
): string | null {
  return CONTROL.test(value)
    ? 'a control character'
    : templateProblem(value, isName);
}

/** The most bytes `value` renders to in a SIP header: its literal text's UTF-8 bytes, each plain
 * `{{placeholder}}`'s maximum and, for any other mustache, the value's own cap, capped at
 * `SIP_HEADER_VALUE_MAX_BYTES`. A value that is no template counts its literal length. */
export function maxRenderedBytes(value: string): number {
  const parts = templateParts(value);
  if (parts === null) {
    return utf8Bytes(value);
  }
  const total = parts.reduce((sum, part) => {
    if ('text' in part) {
      return sum + utf8Bytes(part.text);
    }
    return (
      sum +
      ('name' in part && isCallPlaceholder(part.name)
        ? SIP_HEADER_PLACEHOLDERS[part.name]
        : SIP_HEADER_VALUE_MAX_BYTES)
    );
  }, 0);
  return Math.min(total, SIP_HEADER_VALUE_MAX_BYTES);
}

/** `: ` between a header's name and its value. */
const SEPARATOR_BYTES = 2;

/** How many bytes `headers` may take (§10.3 "Forward targets"): per header its name, 2 for `: `
 * and its value's `maxRenderedBytes`. */
export function sipHeadersSize(headers: readonly SipHeaderTemplate[]): number {
  return headers.reduce(
    (sum, header) =>
      sum +
      header.name.length +
      SEPARATOR_BYTES +
      maxRenderedBytes(header.value),
    0
  );
}

/** A header as its leg sends it. */
export type SipHeader = { name: string; value: string };

/**
 * `templates` rendered for one leg (§9.4 "Header templates"): each placeholder's value without
 * its control characters and cut to its maximum, each mustache's output without control
 * characters, the whole trimmed and cut to 256 bytes; a header whose value renders empty, such as
 * `{{callerNumber}}` for a withheld caller, is left out, and so is one whose value `api` would not
 * have taken. `variables` are the call's other values, an HTTP request's answers by its name.
 */
export function renderSipHeaders(
  templates: readonly SipHeaderTemplate[],
  values: CallValues,
  variables: Readonly<Record<string, unknown>> = {}
): SipHeader[] {
  const cut = Object.fromEntries(
    Object.entries(SIP_HEADER_PLACEHOLDERS).map(([name, max]) => [
      name,
      cutUtf8(
        values[name as SipHeaderPlaceholder].replaceAll(EVERY_CONTROL, ''),
        max
      )
    ])
  );
  const headers: SipHeader[] = [];
  for (const template of templates) {
    const rendered = CONTROL.test(template.value)
      ? null
      : renderTemplate(template.value, { ...variables, ...cut }, 'line');
    const value = cutUtf8(
      (rendered ?? '').trim(),
      SIP_HEADER_VALUE_MAX_BYTES
    ).trimEnd();
    if (value !== '') {
      headers.push({ name: template.name, value });
    }
  }
  return headers;
}
