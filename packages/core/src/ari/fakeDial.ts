/**
 * How `FakeAri` places a channel: `POST /channels` (originate, created and dialled in one) and
 * `POST /channels/create` followed by `POST /channels/{id}/dial`, the two steps a leg takes so its
 * SIP dialog joins the call before the INVITE leaves (§7 level `sip`). As on Asterisk, a created
 * channel is in the app at once (its `StasisStart`, in state `Down`), and a dialled one answers
 * `answerAfterMs` later with a `ChannelStateChange` to `Up`.
 */
import type { RouteResult } from './fakeHttp.js';
import { defaultChannel, type AriEvent, type Channel } from './types.js';

const HTTP_OK = 200;

/** The slice of `FakeAri` placing a channel reads and drives. */
export type DialHost = {
  failOriginate: null | { status: number };
  /** A status `POST /channels/{id}/dial` answers with instead of dialling, for the next `count`
   * dials (every one while `count` is absent), or `null`. */
  failDial: null | { status: number; count?: number };
  /** Whether a created channel enters the app (its `StasisStart`); `false` for one that never
   * does, as a channel Asterisk lost between the create and its Stasis thread. */
  createdEntersStasis: boolean;
  onOriginate: ((channel: Channel) => void) | null;
  answerAfterMs: number;
  emit: (event: AriEvent) => void;
};

// `"Name" <number>`, `Name <number>` or a bare number, as `CALLERID(all)` takes it.
const CALLER_ID = /^(?:"?(?<name>[^"<]*?)"?\s*)?<(?<num>[^>]*)>$/u;

/** The caller a `CALLERID(all)` value names. */
function callerOf(value: string | undefined): Channel['caller'] {
  if (value === undefined) {
    return { number: '', name: '' };
  }
  const match = CALLER_ID.exec(value.trim());
  return match?.groups === undefined
    ? { number: value, name: '' }
    : { number: match.groups.num ?? '', name: match.groups.name ?? '' };
}

function refused(host: DialHost): RouteResult | null {
  return host.failOriginate === null
    ? null
    : {
        status: host.failOriginate.status,
        body: { message: 'Failed to originate channel' }
      };
}

/** Answers `channel` `answerAfterMs` from now, running `onOriginate` first: Asterisk dials while
 * it answers the request, so the channel's events can reach the client ahead of the response. */
function dialNow(host: DialHost, channel: Channel): void {
  host.onOriginate?.(channel);
  setTimeout(() => {
    channel.state = 'Up';
    host.emit({
      type: 'ChannelStateChange',
      timestamp: new Date().toISOString(),
      application: 'zamfono',
      channel
    });
  }, host.answerAfterMs);
}

type PlaceBody = {
  channelId?: string;
  endpoint?: string;
  callerId?: string;
  appArgs?: string;
  variables?: Record<string, string>;
};

/** `POST /channels`: an originate. */
export function fakeOriginate(
  host: DialHost,
  channels: Map<string, Channel>,
  body: unknown
): RouteResult {
  const failure = refused(host);
  if (failure !== null) {
    return failure;
  }
  const params = body as PlaceBody;
  const channel = defaultChannel({
    id: params.channelId,
    name: params.endpoint,
    caller: { number: params.callerId ?? '', name: '' }
  });
  channels.set(channel.id, channel);
  dialNow(host, channel);
  return { status: HTTP_OK, body: channel };
}

/** `POST /channels/create`: the channel, in the app and not dialled yet. */
export function fakeCreate(
  host: DialHost,
  channels: Map<string, Channel>,
  body: unknown
): RouteResult {
  const failure = refused(host);
  if (failure !== null) {
    return failure;
  }
  const params = body as PlaceBody;
  const channel = defaultChannel({
    id: params.channelId,
    name: params.endpoint,
    state: 'Down',
    caller: callerOf(params.variables?.['CALLERID(all)'])
  });
  channels.set(channel.id, channel);
  if (host.createdEntersStasis) {
    host.emit({
      type: 'StasisStart',
      timestamp: new Date().toISOString(),
      application: 'zamfono',
      args: (params.appArgs ?? '').split(','),
      channel: { ...channel }
    });
  }
  return { status: HTTP_OK, body: channel };
}

/** Whether `request` placed a channel: an originate, or a create (whose `dial` follows). Tests
 * read what a leg was placed with from either, since a leg takes one step or two. */
export function isPlacement(request: {
  method: string;
  path: string;
}): boolean {
  return (
    request.method === 'POST' &&
    (request.path === 'channels' || request.path === 'channels/create')
  );
}

/** The caller ID a placement set: an originate's `callerId`, a create's `CALLERID(all)`. */
export function placedCallerId(request: { body: unknown }): string | undefined {
  const body = request.body as PlaceBody | undefined;
  return body?.callerId ?? body?.variables?.['CALLERID(all)'];
}

/** `POST /channels/{id}/dial` for a created channel. */
export function fakeDial(host: DialHost, channel: Channel): RouteResult {
  const failure = host.failDial;
  if (failure !== null) {
    if (failure.count !== undefined) {
      failure.count -= 1;
      host.failDial = failure.count > 0 ? failure : null;
    }
    return {
      status: failure.status,
      body: { message: 'Channel not in Stasis application' }
    };
  }
  dialNow(host, channel);
  return { status: HTTP_OK, body: {} };
}
