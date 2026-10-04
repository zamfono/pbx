// Shapes shared between the thin ARI client and the in-process fake ARI server (§3, §9.2).

/** Minimal structural logger contract satisfied by pino (constructed in main.ts). */
export type Logger = {
  debug: (msgOrFields: string | Record<string, unknown>, msg?: string) => void;
  info: (msgOrFields: string | Record<string, unknown>, msg?: string) => void;
  warn: (msgOrFields: string | Record<string, unknown>, msg?: string) => void;
  error: (msgOrFields: string | Record<string, unknown>, msg?: string) => void;
};

export type Channel = {
  id: string;
  name: string;
  state: string;
  caller: { number: string; name: string };
  connected: { number: string; name: string };
  dialplan: { context: string; exten: string };
  /** When Asterisk created the channel, in its own timestamp format (`asteriskTimeMs`). */
  creationtime: string;
  channelvars?: Record<string, string>;
};

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
  variables?: Record<string, string>;
  channelId?: string;
};

/** `POST /channels/create`'s parameters: an originate's, less the caller ID, which a created
 * channel takes as variables (`CALLERID`, `CONNECTEDLINE`). */
export type CreateParams = Omit<OriginateParams, 'callerId'>;

export type RecordParams = {
  name: string;
  format: 'wav' | 'wav16';
  maxDurationSeconds: number;
  maxSilenceSeconds: number;
  terminateOn: '#' | 'none';
  /** A tone before the recording starts. */
  beep?: boolean;
};

type SnoopParams = {
  spy: 'in' | 'out' | 'both';
  whisper: 'none';
  app: 'zamfono';
  appArgs: string;
  snoopId: string;
};

export type DeviceState =
  'NOT_INUSE' | 'INUSE' | 'BUSY' | 'UNAVAILABLE' | 'RINGING';
export type AsteriskModule =
  'res_pjsip' | 'pbx_config' | 'res_musiconhold' | 'res_hep';

export type Endpoint = {
  technology: 'PJSIP';
  resource: string;
  state: 'online' | 'offline' | 'unknown';
  channel_ids: string[];
};

export type HangupOptions = { reason?: string; reasonCode?: number };

export type ChannelsApi = {
  /** `POST /channels/create`: the channel, in the app from the start but not dialled yet, so its
   * SIP dialog (and Call-ID) exists before its INVITE leaves; `dial` sends it. */
  create: (params: CreateParams) => Promise<Channel>;
  /** `POST /channels/{id}/dial`, `timeout` in seconds. */
  dial: (id: string, timeout: number) => Promise<void>;
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
    name?: string;
  }) => Promise<{ id: string }>;
  addChannel: (bridgeId: string, channelId: string) => Promise<void>;
  removeChannel: (bridgeId: string, channelId: string) => Promise<void>;
  destroy: (bridgeId: string) => Promise<void>;
  list: () => Promise<{ id: string; name: string; channels: string[] }[]>;
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
  /** `GET /asterisk/info?only=status`: when this Asterisk started, as ISO 8601 UTC. */
  startupTime: () => Promise<string>;
};

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
