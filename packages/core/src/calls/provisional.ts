/**
 * How an outbound trunk attempt's provisional responses reach the core (§9.4 "Route
 * fallthrough"), as Asterisk 22 exposes them for a channel ARI originated: a `180 Ringing` moves
 * the channel to `Ringing` and raises a `Dial` event whose `dialstatus` is `RINGING`; a `183
 * Session Progress` leaves the channel `Down` and raises only the `Dial` event, `PROGRESS`; a
 * `100 Trying` changes nothing ARI reports, and shows only in the channel's hangup-cause hash,
 * where chan_pjsip records every response to the INVITE (`HANGUPCAUSE(<channel>,tech)` reads the
 * latest as `SIP 100 Trying`).
 */
import type { AriClient } from '../ari/client.js';
import type { AriEvent, Channel } from '../ari/types.js';

/** The `Dial` statuses of the far end alerting: `180 Ringing` and `183 Session Progress`. */
const ALERTING_DIAL_STATUSES = new Set(['RINGING', 'PROGRESS']);

/** A provisional response, as `HANGUPCAUSE(<channel>,tech)` renders the last one received. */
const PROVISIONAL_TECH_CAUSE = /^SIP 1\d\d\b/u;

/** The originated trunk leg: its id for events and REST, its name for the hangup-cause hash. */
export type TrunkLeg = { id: string; name: string };

/** Whether `event` is the far end of `channelId` alerting, with a 180 or a 183 (§9.4). */
export function alertsOn(event: AriEvent, channelId: string): boolean {
  if (event.type === 'Dial') {
    const peer = event.peer as Channel | undefined;
    return (
      peer?.id === channelId &&
      ALERTING_DIAL_STATUSES.has(String(event.dialstatus))
    );
  }
  const channel = event.channel as Channel | undefined;
  return (
    event.type === 'ChannelStateChange' &&
    channel?.id === channelId &&
    channel.state === 'Ringing'
  );
}

/**
 * Whether the INVITE of `leg` has had a provisional response, `100 Trying` included, which no
 * event carries: read once, when the 8-second budget runs out (§9.4 "Route fallthrough").
 */
export async function provisionalArrived(
  ari: AriClient,
  leg: TrunkLeg
): Promise<boolean> {
  const cause = await ari.channels
    .getVariable(leg.id, `HANGUPCAUSE(${leg.name},tech)`)
    .catch(() => null);
  return cause !== null && PROVISIONAL_TECH_CAUSE.test(cause);
}
