// ARI's event stream as core reads it (§3, §9.2): the events it handles, typed once.
import type { Channel, Logger } from './types.js';

/** ARI's `result` of a bridge transfer. */
type TransferResult = 'Fail' | 'Invalid' | 'Not Permitted' | 'Success';

/** A bridge as an ARI event names it. */
type Bridge = { id: string };

/** What every frame of the ARI events WebSocket stream carries; `channel` is the channel the
 * event concerns, when it names one. */
type EventBase = {
  timestamp: string;
  application: 'zamfono';
  channel?: Channel;
};

/** An event about `channel`, of ARI's event type `T`, with `fields` beside it. */
type ChannelEvent<T extends string, Fields = object> = EventBase & {
  type: T;
  channel: Channel;
} & Fields;

/** The events core handles, from ARI's own event model (Asterisk 22 `events.json`), with the
 * fields core reads. */
export type KnownAriEvent =
  | ChannelEvent<'StasisStart', { args: string[] }>
  | ChannelEvent<'StasisEnd'>
  | ChannelEvent<
      'ChannelDestroyed',
      { cause: number; cause_txt: string; tech_cause?: number }
    >
  | ChannelEvent<'ChannelStateChange'>
  | ChannelEvent<'ChannelDtmfReceived', { digit: string }>
  | ChannelEvent<'ChannelHangupRequest', { cause?: number; soft?: boolean }>
  | ChannelEvent<'ChannelLeftBridge'>
  | ChannelEvent<
      'BridgeBlindTransfer',
      {
        exten: string;
        result: TransferResult;
        transferee?: Channel;
        replace_channel?: Channel;
      }
    >
  | (EventBase & {
      type: 'BridgeAttendedTransfer';
      transferer_first_leg: Channel;
      transferer_second_leg: Channel;
      transferer_first_leg_bridge?: Bridge;
      destination_type: 'bridge' | 'application' | 'link' | 'threeway' | 'fail';
      destination_bridge?: string;
      destination_link_first_leg?: Channel;
      destination_link_second_leg?: Channel;
      transferee?: Channel;
      result: TransferResult;
    })
  | (EventBase & {
      type: 'Dial';
      peer: Channel;
      dialstatus: string;
    })
  | (EventBase & { type: 'PlaybackFinished'; playback: { id: string } })
  | (EventBase & {
      type: 'RecordingFinished' | 'RecordingFailed';
      recording: { name: string; duration?: number };
    })
  | (EventBase & {
      type: 'ContactStatusChange';
      contact_info: { aor: string; contact_status: string };
    });

/** One frame of the ARI events WebSocket stream: one of the events core handles, or any other
 * event type, of which core reads the type and the channel alone. Narrow with `isEvent`. */
export type AriEvent = KnownAriEvent | (EventBase & { type: string });

/** The known event of type `T`. */
export type AriEventOf<T extends KnownAriEvent['type']> = Extract<
  KnownAriEvent,
  { type: T }
>;

/** Whether `ev` is one of `types`; narrows it to that event's fields. A string comparison of
 * `ev.type` cannot, since `AriEvent`'s other events carry any type. */
export function isEvent<T extends KnownAriEvent['type']>(
  ev: AriEvent,
  ...types: T[]
): ev is AriEventOf<T> {
  return types.some(type => type === ev.type);
}

/** Parses one ARI event frame, logging and returning `null` on malformed JSON instead of throwing. */
export function tryParseAriEvent(raw: string, log: Logger): AriEvent | null {
  try {
    return JSON.parse(raw) as AriEvent;
  } catch (error) {
    log.error({ raw, error }, 'received a malformed ARI event');
    return null;
  }
}
