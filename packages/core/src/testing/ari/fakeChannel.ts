/**
 * Channel behaviour `FakeAri` delegates: the parts of Asterisk's own conduct a test relies on but
 * that need no access to the fake's channel model.
 */
import { randomUUID } from 'node:crypto';

import {
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK
} from '@zamfono/shared';

import type { AriEvent } from '#src/ari/events.js';
import type { Channel } from '#src/ari/types.js';

type RouteResult = { status: number; body: unknown };

/** The slice of `FakeAri` the recording scheduler drives. */
type RecordingHost = {
  recordingFinishedAfterMs: number | null;
  recordedDurationS: number;
  emit: (event: AriEvent) => void;
};

/**
 * Fires `RecordingFinished` once `recordingFinishedAfterMs` elapses. Asterisk ends a recording
 * when the channel hangs up or the cap hits; `null` leaves every recording open, so a test that
 * emits the event itself keeps full control of its duration.
 */
export function scheduleRecordingFinished(
  host: RecordingHost,
  body: unknown
): void {
  const delay = host.recordingFinishedAfterMs;
  const name = (body as { name?: string } | undefined)?.name;
  if (delay === null || name === undefined) {
    return;
  }
  const timer = setTimeout(() => {
    host.emit({
      type: 'RecordingFinished',
      timestamp: new Date().toISOString(),
      application: 'zamfono',
      recording: { name, duration: host.recordedDurationS }
    });
  }, delay);
  timer.unref();
}

/** `GET /channels/{id}/variable`, answered as Asterisk does: 404 for an unset variable, 500 for a
 * dialplan function (`NAME(args)`) with nothing to read. */
export function readChannelVariable(
  variables: ReadonlyMap<string, string>,
  id: string,
  queryString: string
): RouteResult {
  const name = new URLSearchParams(queryString).get('variable') ?? '';
  const value = variables.get(`${id}:${name}`);
  if (value !== undefined) {
    return { status: HTTP_OK, body: { value } };
  }
  return name.includes('(')
    ? {
        status: HTTP_INTERNAL_SERVER_ERROR,
        body: { message: 'Unable to read provided function' }
      }
    : { status: HTTP_NOT_FOUND, body: { message: 'Variable not found' } };
}

/** One entry of `GET /ari/endpoints`, in ARI's own wire shape. */
export type FakeEndpoint = {
  technology: 'PJSIP';
  resource: string;
  state: 'online' | 'offline' | 'unknown';
  channel_ids: string[];
};

/** An online endpoint for `sipUsername`, as a registered phone appears to ARI. */
export function fakeEndpoint(sipUsername: string): FakeEndpoint {
  return {
    technology: 'PJSIP',
    resource: sipUsername,
    state: 'online',
    channel_ids: []
  };
}

/** When the fake Asterisk "started", in Asterisk's own `startup_time` format. */
export const FAKE_ASTERISK_STARTUP_TIME = '2026-09-29T08:00:00.000+0000';

/**
 * Routes the fake models no state for: device states and mailboxes acknowledge, and the endpoint
 * list answers whatever the fake was told to report. Playbacks stay with the fake itself, since
 * stopping one needs its timer.
 */
export function routeMisc(
  method: string,
  path: string,
  endpoints: readonly unknown[],
  startupTime: string
): RouteResult {
  if (path.startsWith('deviceStates/') && method === 'PUT') {
    return { status: HTTP_OK, body: {} };
  }
  if (path.startsWith('mailboxes/') && method === 'PUT') {
    return { status: HTTP_OK, body: {} };
  }
  if (path === 'endpoints' && method === 'GET') {
    return { status: HTTP_OK, body: endpoints };
  }
  if (path.startsWith('asterisk/modules/') && method === 'PUT') {
    return { status: HTTP_OK, body: {} };
  }
  if (path === 'asterisk/info' && method === 'GET') {
    return {
      status: HTTP_OK,
      body: { status: { startup_time: startupTime } }
    };
  }
  return { status: HTTP_NOT_FOUND, body: { message: 'Not found' } };
}

/** The `PeerStatusChange` Asterisk fires for `sipUsername`'s endpoint: `Reachable` when its AOR's
 * first contact becomes reachable, `Unreachable` when its last one stops being reachable (§9.3). */
export function peerStatusChange(
  sipUsername: string,
  peerStatus: 'Reachable' | 'Unreachable' = 'Reachable'
): AriEvent {
  return {
    type: 'PeerStatusChange',
    timestamp: new Date().toISOString(),
    application: 'zamfono',
    endpoint: {
      ...fakeEndpoint(sipUsername),
      state: peerStatus === 'Reachable' ? 'online' : 'offline'
    },
    peer: { peer_status: peerStatus }
  };
}

/** Fills in a `Channel`'s defaults for the fields a test does not set. */
export function defaultChannel(overrides: Partial<Channel>): Channel {
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'PJSIP/unknown',
    state: overrides.state ?? 'Ring',
    caller: overrides.caller ?? { number: '', name: '' },
    connected: overrides.connected ?? { number: '', name: '' },
    dialplan: overrides.dialplan ?? { context: '', exten: '' },
    creationtime:
      overrides.creationtime ?? new Date().toISOString().replace('Z', '+0000'),
    channelvars: overrides.channelvars
  };
}

/**
 * What Asterisk reports as `channel` hangs up with Q.850 `cause`: a party's own hangup (a BYE, a
 * CANCEL) raises a hard `ChannelHangupRequest` first, one the client requested itself
 * (`DELETE /channels/{id}`) none. Either way the channel leaves Stasis, then is destroyed.
 */
export function hangupEvents(
  channel: Channel,
  cause: number,
  byParty: boolean
): AriEvent[] {
  const base = {
    timestamp: new Date().toISOString(),
    application: 'zamfono' as const,
    channel
  };
  const ending: AriEvent[] = [
    { ...base, type: 'StasisEnd' },
    { ...base, type: 'ChannelDestroyed', cause, cause_txt: 'Normal Clearing' }
  ];
  return byParty
    ? [{ ...base, type: 'ChannelHangupRequest', cause }, ...ending]
    : ending;
}
