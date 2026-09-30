/**
 * The custom SIP headers a forwarded trunk leg carries (§9.4 "Forwarded calls"): the original
 * caller and the called company number, for the carrier or the AI agent answering a forward. One
 * pure function from the call's metadata to the headers, applied to the leg at its originate
 * (`trunkDial.ts`) and nowhere else.
 */
import { ANONYMOUS, isE164 } from '@zamfono/shared';

/** What a forwarded leg's headers say about its call. */
export type ForwardMeta = {
  /** The original caller: an inbound caller's international form, an internal caller's
   * extension, `anonymous` for a withheld number (§9.4 "Withheld caller"). */
  caller: string;
  /** The number an inbound call was placed to, `null` for an internal call. */
  called: string | null;
};

export type SipHeader = { name: string; value: string };

/**
 * `X-Zamfono-Caller`, unless the caller withheld their number, and `X-Zamfono-Did`, for an inbound
 * call to a company number in the international form, not a provider's verbatim string.
 */
export function forwardHeaders(meta: ForwardMeta): SipHeader[] {
  const headers: SipHeader[] = [];
  if (meta.caller !== '' && meta.caller !== ANONYMOUS) {
    headers.push({ name: 'X-Zamfono-Caller', value: meta.caller });
  }
  if (meta.called !== null && isE164(meta.called)) {
    headers.push({ name: 'X-Zamfono-Did', value: meta.called });
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
