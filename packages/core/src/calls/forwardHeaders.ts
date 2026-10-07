/**
 * A `sip` target's custom headers as its forwarded trunk leg sends them (§9.4 "Header templates"):
 * one pure function from the target's templates and the call's placeholder values to the headers,
 * and the variables that add them to the leg at its originate (`trunkDial.ts`, through
 * `forwardLeg.ts`'s `forwardVariables`), the one place a forwarded leg's headers are applied.
 * The value syntax and each placeholder's maximum are `@zamfono/shared`'s, which `api` validates
 * a target's headers with.
 */
import {
  parseSipHeaderValue,
  SIP_HEADER_PLACEHOLDERS,
  SIP_HEADER_VALUE_MAX_BYTES,
  utf8Bytes,
  type SipHeaderPart,
  type SipHeaderPlaceholder,
  type SipHeaderTemplate
} from '@zamfono/shared';

export type SipHeader = { name: string; value: string };

/** Every placeholder's value for one leg, before it is cleaned and cut. */
export type ForwardValues = Record<SipHeaderPlaceholder, string>;

// CR, LF, tab and the rest of C0, DEL and C1: nothing that could end a header or reshape it.
const CONTROL = /\p{Cc}/gu;

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

/** One part as rendered: literal text as written, a placeholder's value without control
 * characters and cut to the placeholder's maximum. */
function renderPart(part: SipHeaderPart, values: ForwardValues): string {
  if ('text' in part) {
    return part.text;
  }
  return cutUtf8(
    values[part.placeholder].replaceAll(CONTROL, ''),
    SIP_HEADER_PLACEHOLDERS[part.placeholder]
  );
}

/**
 * `templates` rendered with `values`: each value's placeholders substituted, the whole trimmed
 * and cut to 256 bytes; a header whose value renders empty, such as `{{callerNumber}}` for a
 * withheld caller, is left out, and so is one whose value `api` would not have taken, a literal
 * control character among them. Nothing here is expanded later: the value is set as an
 * originate variable, which Asterisk takes literally, so a `${…}` in it is sent as written.
 */
export function renderForwardHeaders(
  templates: readonly SipHeaderTemplate[],
  values: ForwardValues
): SipHeader[] {
  const headers: SipHeader[] = [];
  for (const template of templates) {
    const parsed = parseSipHeaderValue(template.value);
    if (!parsed.ok) {
      continue;
    }
    const rendered = parsed.parts
      .map(part => renderPart(part, values))
      .join('')
      .trim();
    const value = cutUtf8(rendered, SIP_HEADER_VALUE_MAX_BYTES).trimEnd();
    if (value !== '') {
      headers.push({ name: template.name, value });
    }
  }
  return headers;
}

/** `headers` as the variables a created channel adds them with (`PJSIP_HEADER(add,…)`), which
 * chan_pjsip puts on the INVITE it sends once the channel is dialled. */
export function headerVariables(headers: SipHeader[]): Record<string, string> {
  return Object.fromEntries(
    headers.map(header => [`PJSIP_HEADER(add,${header.name})`, header.value])
  );
}
