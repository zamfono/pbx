// Shapes shared between the thin ARI client and the in-process fake ARI server (§3, §9.2).
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';

/** Minimal structural logger contract satisfied by pino (constructed in main.ts). */
export type Logger = {
  /** Optional: most test loggers leave it out, and nothing that must be seen is logged at debug. */
  debug?: (msgOrFields: string | Record<string, unknown>, msg?: string) => void;
  info: (msgOrFields: string | Record<string, unknown>, msg?: string) => void;
  warn: (msgOrFields: string | Record<string, unknown>, msg?: string) => void;
  error: (msgOrFields: string | Record<string, unknown>, msg?: string) => void;
};

/** One frame of the ARI events WebSocket stream; StasisStart carries `args` and `channel`. */
export type AriEvent = {
  type: string;
  timestamp: string;
  application: 'zamfono';
  [key: string]: unknown;
};

export type Channel = {
  id: string;
  name: string;
  state: string;
  caller: { number: string; name: string };
  connected: { number: string; name: string };
  dialplan: { context: string; exten: string };
  channelvars?: Record<string, string>;
};

/** Fills in a `Channel`'s defaults for the fields the fake ARI server does not receive. */
export function defaultChannel(overrides: Partial<Channel>): Channel {
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'PJSIP/unknown',
    state: overrides.state ?? 'Ring',
    caller: overrides.caller ?? { number: '', name: '' },
    connected: overrides.connected ?? { number: '', name: '' },
    dialplan: overrides.dialplan ?? { context: '', exten: '' },
    channelvars: overrides.channelvars
  };
}

/** Thrown by every ARI REST wrapper when Asterisk answers with a non-2xx status. */
export class AriError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`ARI request failed with status ${status}`);
    this.name = 'AriError';
    this.status = status;
    this.body = body;
  }
}

export type OriginateParams = {
  endpoint: string;
  app: 'zamfono';
  appArgs: string;
  callerId?: string;
  timeout?: number;
  variables?: Record<string, string>;
  channelId?: string;
};

export type RecordParams = {
  name: string;
  format: 'wav' | 'wav16';
  maxDurationSeconds: number;
  maxSilenceSeconds: number;
  terminateOn: '#' | 'none';
  /** A tone before the recording starts. */
  beep?: boolean;
};

export type SnoopParams = {
  spy: 'in' | 'out' | 'both';
  whisper: 'none';
  app: 'zamfono';
  appArgs: string;
  snoopId: string;
};

/**
 * The fields of ARI's `RTPstat` (`GET /channels/{id}/rtp_statistics`) the `call_qos` summary reads
 * (§7 level `qos`), as `res_rtp_asterisk` fills them: packet counts as integers, jitter and round
 * trip in seconds. `txjitter` is this side's own interarrival jitter of the packets it received,
 * `rxjitter` the peer's of the packets it received, from its RTCP receiver report; `rxploss` the
 * packets this side missed as of its last RTCP report, `txploss` those the peer reported missing;
 * `rtt` the last round trip measured from a receiver report, 0 while none arrived. ARI sends more
 * (per-side minimum, maximum and mean figures, SSRCs, octets), which nothing here reads.
 */
export type RtpStatistics = {
  txcount: number;
  rxcount: number;
  txjitter: number;
  rxjitter: number;
  txploss: number;
  rxploss: number;
  rtt: number;
};
export type DeviceState =
  'NOT_INUSE' | 'INUSE' | 'BUSY' | 'UNAVAILABLE' | 'RINGING';
export type AsteriskModule = 'res_pjsip' | 'pbx_config' | 'res_musiconhold';

export type Endpoint = {
  technology: 'PJSIP';
  resource: string;
  state: 'online' | 'offline' | 'unknown';
  channel_ids: string[];
};

export type HangupOptions = { reason?: string; reasonCode?: number };

export type ChannelsApi = {
  originate: (params: OriginateParams) => Promise<Channel>;
  answer: (id: string) => Promise<void>;
  // `reason` is ARI's named enum (normal, busy, congestion, …); `reasonCode` is a Q.850 cause sent
  // as the `reason_code` query parameter, which chan_pjsip turns into the SIP final response
  // (`calls/releaseCause.ts`) — Asterisk answers 400 to any `reason` outside its enum.
  // `reasonCode` wins when both are given.
  hangup: (id: string, opts?: HangupOptions) => Promise<void>;
  // A list plays its items in order as one playback, with one `PlaybackFinished` at its end.
  play: (
    id: string,
    media: string | readonly string[],
    playbackId?: string
  ) => Promise<{ id: string }>;
  record: (id: string, params: RecordParams) => Promise<void>;
  snoop: (id: string, params: SnoopParams) => Promise<Channel>;
  rtpStatistics: (id: string) => Promise<RtpStatistics | null>;
  setVar: (id: string, name: string, value: string) => Promise<void>;
  /** `GET /channels/{id}/variable`, `null` when the channel or the variable is absent. Reading
   * `CHANNEL(pjsip,call-id)` is how a call is matched to its HEP stream (§7 level `sip`). */
  getVariable: (id: string, name: string) => Promise<string | null>;
  continueInDialplan: (
    id: string,
    params: { context: string; extension: string; priority: number }
  ) => Promise<void>;
  list: () => Promise<Channel[]>;
  ring: (id: string) => Promise<void>;
  startMoh: (id: string, mohClass?: string) => Promise<void>;
  stopMoh: (id: string) => Promise<void>;
  sendDtmf: (id: string, dtmf: string) => Promise<void>;
};

export type BridgesApi = {
  create: (params: {
    type: 'mixing' | 'holding';
    bridgeId?: string;
  }) => Promise<{ id: string }>;
  addChannel: (bridgeId: string, channelId: string) => Promise<void>;
  removeChannel: (bridgeId: string, channelId: string) => Promise<void>;
  destroy: (bridgeId: string) => Promise<void>;
  list: () => Promise<{ id: string; channels: string[] }[]>;
  startMoh: (bridgeId: string, mohClass?: string) => Promise<void>;
  play: (bridgeId: string, media: string) => Promise<{ id: string }>;
};

export type PlaybacksApi = { stop: (id: string) => Promise<void> };
export type DeviceStatesApi = {
  put: (name: string, state: DeviceState) => Promise<void>;
};
export type MailboxesApi = {
  put: (
    name: string,
    oldMessages: number,
    newMessages: number
  ) => Promise<void>;
};
export type EndpointsApi = { list: () => Promise<Endpoint[]> };
export type AsteriskApi = {
  reloadModule: (name: AsteriskModule) => Promise<void>;
};

/** Parses a WebSocket frame's payload into a UTF-8 string regardless of its `RawData` shape. */
export function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
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

/** Reads an ARI error response's body as JSON, falling back to plain text. */
export async function parseErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
