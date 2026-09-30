/**
 * A `sip` forward target's custom headers (§9.4 "Header templates", §10.3 "Forward targets"): the
 * placeholders a value may name, each with the most bytes it renders to, and the one reading of a
 * value's `{{placeholder}}` syntax. `api` validates a target's headers with them on write and
 * `core` renders them at the originate, so the two cannot disagree on what a value means.
 */

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

/** One piece of a parsed value: literal text, or a placeholder substituted at the originate. */
export type SipHeaderPart =
  { text: string } | { placeholder: SipHeaderPlaceholder };

export type ParsedSipHeaderValue =
  { ok: true; parts: SipHeaderPart[] } | { ok: false; reason: string };

/** A `{{name}}`, spaces allowed inside the braces as the mail templates allow them. */
const PLACEHOLDER = /^\{\{\s*(?<name>[A-Za-z][A-Za-z0-9]*)\s*\}\}/u;
const OPEN = '{{';
const CONTROL = /\p{Cc}/u;
const utf8 = new TextEncoder();

/** `text`'s length in bytes of UTF-8, the unit every size here is in. */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

function isPlaceholder(name: string): name is SipHeaderPlaceholder {
  return Object.hasOwn(SIP_HEADER_PLACEHOLDERS, name);
}

/**
 * Reads `value` into literal text and placeholders: every `{{` opens a `{{name}}` of the table, and
 * there are no blocks, helpers or escapes (§9.4 "Header templates"). Refuses a control character,
 * which could end the header, a `{{` that opens nothing, and a name the table does not have.
 */
export function parseSipHeaderValue(value: string): ParsedSipHeaderValue {
  if (CONTROL.test(value)) {
    return { ok: false, reason: 'a control character' };
  }
  const parts: SipHeaderPart[] = [];
  let rest = value;
  while (rest !== '') {
    const open = rest.indexOf(OPEN);
    if (open === -1) {
      parts.push({ text: rest });
      break;
    }
    if (open > 0) {
      parts.push({ text: rest.slice(0, open) });
    }
    const match = PLACEHOLDER.exec(rest.slice(open));
    const name = match?.groups?.name;
    if (match === null || name === undefined) {
      return { ok: false, reason: `a '{{' that opens no {{placeholder}}` };
    }
    if (!isPlaceholder(name)) {
      return { ok: false, reason: `the unknown placeholder '${name}'` };
    }
    parts.push({ placeholder: name });
    rest = rest.slice(open + match[0].length);
  }
  return { ok: true, parts };
}

/** The most bytes `parts` render to: the literal text's UTF-8 bytes and each placeholder's
 * maximum, capped at `SIP_HEADER_VALUE_MAX_BYTES`. */
export function maxRenderedBytes(parts: SipHeaderPart[]): number {
  const total = parts.reduce(
    (sum, part) =>
      sum +
      ('text' in part
        ? utf8Bytes(part.text)
        : SIP_HEADER_PLACEHOLDERS[part.placeholder]),
    0
  );
  return Math.min(total, SIP_HEADER_VALUE_MAX_BYTES);
}

/** `: ` between a header's name and its value. */
const SEPARATOR_BYTES = 2;

/** How many bytes `headers` may take (§10.3 "Forward targets"): per header its name, 2 for `: `
 * and its value's `maxRenderedBytes`. A value that does not parse counts its literal length. */
export function sipHeadersSize(headers: readonly SipHeaderTemplate[]): number {
  return headers.reduce((sum, header) => {
    const parsed = parseSipHeaderValue(header.value);
    const value = parsed.ok
      ? maxRenderedBytes(parsed.parts)
      : utf8Bytes(header.value);
    return sum + header.name.length + SEPARATOR_BYTES + value;
  }, 0);
}
