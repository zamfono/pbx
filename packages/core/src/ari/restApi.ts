/**
 * The REST surface Asterisk 22's ARI offers, as the promise-returning namespaces `AriClient`
 * exposes (§3, §9.2). Each wrapper maps one call onto its ARI method and path; the HTTP itself is
 * `restTransport.ts`'s.
 */
import { channelVariable } from './channelReads.js';
import { ModuleReloader } from './moduleReloader.js';
import type { AriRequests } from './restTransport.js';
import type {
  AsteriskApi,
  BridgesApi,
  ChannelsApi,
  DeviceStatesApi,
  Endpoint,
  EndpointsApi,
  HangupOptions,
  MailboxesApi,
  PlaybacksApi
} from './types.js';

/** Every namespace of the ARI REST surface, keyed as `AriClient` exposes them. */
type AriRestApi = {
  channels: ChannelsApi;
  bridges: BridgesApi;
  playbacks: PlaybacksApi;
  deviceStates: DeviceStatesApi;
  mailboxes: MailboxesApi;
  endpoints: EndpointsApi;
  asterisk: AsteriskApi;
};

function hangup(
  rest: AriRequests,
  id: string,
  opts?: HangupOptions
): Promise<void> {
  const query = new URLSearchParams();
  if (opts?.reasonCode !== undefined) {
    query.set('reason_code', String(opts.reasonCode));
  } else if (opts?.reason !== undefined) {
    query.set('reason', opts.reason);
  }
  const queryString = query.toString();
  return rest.void(
    'DELETE',
    queryString === '' ? `channels/${id}` : `channels/${id}?${queryString}`
  );
}

function buildChannelsApi(rest: AriRequests): ChannelsApi {
  return {
    create: params => rest.json('POST', 'channels/create', params),
    dial: (id, timeout) =>
      rest.void('POST', `channels/${id}/dial`, { timeout }),
    answer: id => rest.void('POST', `channels/${id}/answer`),
    hangup: (id, opts) => hangup(rest, id, opts),
    play: (id, media, playbackId) =>
      rest.json('POST', `channels/${id}/play`, { media, playbackId }),
    record: (id, params) => rest.void('POST', `channels/${id}/record`, params),
    snoop: (id, params) => rest.json('POST', `channels/${id}/snoop`, params),
    setVar: (id, name, value) =>
      rest.void('POST', `channels/${id}/variable`, {
        variable: name,
        value
      }),
    getVariable: (id, name) => channelVariable(rest.json, id, name),
    continueInDialplan: (id, params) =>
      rest.void('POST', `channels/${id}/continue`, params),
    list: () => rest.json('GET', 'channels'),
    ring: id => rest.void('POST', `channels/${id}/ring`),
    startMoh: (id, mohClass) =>
      rest.void('POST', `channels/${id}/moh`, { mohClass }),
    stopMoh: id => rest.void('DELETE', `channels/${id}/moh`),
    sendDtmf: (id, dtmf) => rest.void('POST', `channels/${id}/dtmf`, { dtmf })
  };
}

function buildBridgesApi(rest: AriRequests): BridgesApi {
  return {
    create: params => rest.json('POST', 'bridges', params),
    addChannel: (bridgeId, channelId) =>
      rest.void('POST', `bridges/${bridgeId}/addChannel`, {
        channel: channelId
      }),
    removeChannel: (bridgeId, channelId) =>
      rest.void('POST', `bridges/${bridgeId}/removeChannel`, {
        channel: channelId
      }),
    destroy: bridgeId => rest.void('DELETE', `bridges/${bridgeId}`),
    list: () => rest.json('GET', 'bridges'),
    startMoh: (bridgeId, mohClass) =>
      rest.void('POST', `bridges/${bridgeId}/moh`, { mohClass }),
    play: (bridgeId, media) =>
      rest.json('POST', `bridges/${bridgeId}/play`, { media })
  };
}

/**
 * Asterisk's `startup_time` (`2026-09-29T10:00:00.000+0000`, an offset without a colon) as ISO
 * 8601 UTC; anything else is an error, since a start time nobody can compare says nothing.
 */
export function isoStartupTime(raw: unknown): string {
  if (typeof raw === 'string') {
    const parsed = Date.parse(
      raw.replace(
        /(?<hours>[+-]\d{2})(?<minutes>\d{2})$/u,
        '$<hours>:$<minutes>'
      )
    );
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  throw new Error(`ARI: unreadable startup_time ${JSON.stringify(raw)}`);
}

/**
 * Module reloads go through one `ModuleReloader` per client, which runs them one at a time and
 * retries the ones Asterisk refuses while another reload runs (`moduleReloader.ts`).
 */
function buildAsteriskApi(rest: AriRequests): AsteriskApi {
  const reloader = new ModuleReloader(name =>
    rest.void('PUT', `asterisk/modules/${name}`)
  );
  return {
    reloadModule: name => reloader.reload(name),
    startupTime: async () => {
      const info = await rest.json<{ status?: { startup_time?: unknown } }>(
        'GET',
        'asterisk/info?only=status'
      );
      return isoStartupTime(info.status?.startup_time);
    }
  };
}

/** The whole ARI REST surface over `rest`. */
export function buildRestApi(rest: AriRequests): AriRestApi {
  return {
    channels: buildChannelsApi(rest),
    bridges: buildBridgesApi(rest),
    playbacks: {
      stop: id => rest.void('DELETE', `playbacks/${id}`)
    },
    deviceStates: {
      put: (name, state) =>
        rest.void('PUT', `deviceStates/${name}`, { deviceState: state })
    },
    mailboxes: {
      put: (name, oldMessages, newMessages) =>
        rest.void('PUT', `mailboxes/${name}`, {
          oldMessages,
          newMessages
        })
    },
    endpoints: {
      list: () => rest.json<Endpoint[]>('GET', 'endpoints')
    },
    asterisk: buildAsteriskApi(rest)
  };
}
