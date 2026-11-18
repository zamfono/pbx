/**
 * A `sip` target's custom headers on its forwarded trunk leg (§9.4 "Header templates"): the
 * variables that add the rendered headers to the leg at its originate (`trunkDial.ts`, through
 * `forwardLeg.ts`'s `forwardVariables`), the one place a forwarded leg's headers are applied. The
 * rendering is `@zamfono/shared`'s (`renderSipHeaders`), with the renderer `api` validates a
 * target's headers against.
 */
import type { SipHeader } from '@zamfono/shared';

export type { SipHeader } from '@zamfono/shared';

/** `headers` as the variables a created channel adds them with (`PJSIP_HEADER(add,…)`), which
 * chan_pjsip puts on the INVITE it sends once the channel is dialled. Nothing here is expanded
 * later: Asterisk takes an originate variable literally, so a `${…}` in it is sent as written. */
export function headerVariables(headers: SipHeader[]): Record<string, string> {
  return Object.fromEntries(
    headers.map(header => [`PJSIP_HEADER(add,${header.name})`, header.value])
  );
}
