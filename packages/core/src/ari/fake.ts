// In-process fake ARI server: HTTP + WebSocket, an in-memory channel/bridge model, for tests only.
import { routeBridge, type Bridge } from './fakeBridge.js';
import {
  contactReachable,
  fakeEndpoint,
  readChannelVariable,
  routeMisc,
  scheduleRecordingFinished,
  type FakeEndpoint
} from './fakeChannel.js';
import { splitResource, type RouteResult } from './fakeHttp.js';
import { FakePlaybacks } from './fakePlayback.js';
import { readRtpStatistics } from './fakeRtp.js';
import { FakeAriTransport, type FakeRequest } from './fakeTransport.js';
import {
  defaultChannel,
  type AriEvent,
  type Channel,
  type RtpStatistics
} from './types.js';

const DEFAULT_ANSWER_AFTER_MS = 10;
// A real playback takes some time to reach the end; a fixed short delay lets code that awaits
// `PlaybackFinished` (announce, voicemail's greeting, the menu greeting) be exercised for real
// instead of racing a same-tick response, without slowing the suite down noticeably.
const DEFAULT_PLAYBACK_FINISHED_AFTER_MS = 10;
const HTTP_OK = 200;
const DEFAULT_RECORDED_DURATION_S = 3;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
// Asterisk answers a snoop request before its channel enters Stasis; a short delay keeps every
// recording test honest about waiting for the `StasisStart` before recording on it.
const DEFAULT_SNOOP_STASIS_AFTER_MS = 5;
// One request the fake received; `qs` is its raw query string (e.g. `reason_code=21`).
type CallRecord = FakeRequest;

// ponytail: acked, state-free channel actions — nothing in the fake's model depends on them.
const ACKED_CHANNEL_ACTIONS = new Set([
  'POST answer',
  'POST record',
  'POST variable',
  'POST continue',
  'POST ring',
  'POST moh',
  'POST dtmf',
  'DELETE moh'
]);

export class FakeAri {
  readonly calls: CallRecord[] = [];
  answerAfterMs = DEFAULT_ANSWER_AFTER_MS;
  playbackFinishedAfterMs = DEFAULT_PLAYBACK_FINISHED_AFTER_MS;
  /**
   * How long a `record` runs before the fake fires `RecordingFinished` for it, or `null` to leave
   * every recording open. Asterisk ends a recording when the channel hangs up or the cap hits;
   * `null` is the default so a test that emits the event itself, asserting on its duration, keeps
   * full control, and a test that only routes *through* a deposit sets a small value.
   */
  recordingFinishedAfterMs: number | null = null;
  recordedDurationS = DEFAULT_RECORDED_DURATION_S;
  /** Channel variables the fake serves to `GET /channels/{id}/variable`, keyed `<channelId>:<name>`. */
  readonly channelVariables = new Map<string, string>();
  /** What `GET /ari/endpoints` reports; `Presence.resyncOnBoot` reads it to seed registration. */
  readonly endpoints: FakeEndpoint[] = [];
  /** `GET /channels/{id}/rtp_statistics` per channel id; a channel not listed answers the
   * realistic default body (`fakeRtpStatistics`), and `null` answers 404, as Asterisk does for a
   * channel without an RTP instance. */
  readonly rtpStatistics = new Map<string, RtpStatistics | null>();

  /**
   * Reports `sipUsername` as online, as a phone that has REGISTERed would appear: both in the
   * endpoint list a boot resync reads and as the `ContactStatusChange` Asterisk fires at the
   * moment of registration, so a listener that is already running sees it without a resync.
   */
  registerEndpoint(sipUsername: string): void {
    this.endpoints.push(fakeEndpoint(sipUsername));
    this.emit(contactReachable(sipUsername));
  }
  failOriginate: null | { status: number } = null;
  /**
   * Runs as an originate is handled, before its response is sent: Asterisk dials the channel
   * while it answers the request, so its events can reach the client ahead of the response.
   */
  onOriginate: ((channel: Channel) => void) | null = null;
  /**
   * How long to hold `request` before handling it (and recording it in `calls`), or `null` to
   * handle every request at once: a request on a slow connection reaches Asterisk after one sent
   * later on another, which is what a test of request ordering needs to reproduce.
   */
  requestDelayMs: ((request: FakeRequest) => number) | null = null;
  /** How long a snoop channel takes to enter Stasis after its creation, `null` for never. */
  snoopStasisAfterMs: number | null = DEFAULT_SNOOP_STASIS_AFTER_MS;
  private readonly snoopsOutsideStasis = new Set<string>();
  private readonly channels = new Map<string, Channel>();
  private readonly bridges = new Map<string, Bridge>();
  private readonly playbacks = new FakePlaybacks(this);
  private readonly transport = new FakeAriTransport(
    request => {
      this.calls.push(request);
      return this.route(request.method, request.path, request.body, request.qs);
    },
    request => this.requestDelayMs?.(request) ?? 0
  );

  listen(): Promise<{ url: string }> {
    return this.transport.listen();
  }

  close(): Promise<void> {
    this.playbacks.clear();
    return this.transport.close();
  }

  /** Test-only: drop the connected client's socket so a reconnect can be observed. */
  disconnectClient(): void {
    this.transport.disconnectClient();
  }

  emit(event: AriEvent): void {
    if (event.type === 'StasisStart') {
      const channel = event.channel as Channel | undefined;
      this.snoopsOutsideStasis.delete(channel?.id ?? '');
    }
    this.transport.send(event);
  }

  addChannel(overrides: Partial<Channel>): Channel {
    const channel = defaultChannel(overrides);
    this.channels.set(channel.id, channel);
    return channel;
  }

  /**
   * `POST /channels/{id}/snoop`: a snoop channel under the requested `snoopId`. Asterisk answers
   * the request before the channel has entered Stasis, and refuses a `record` on it until then;
   * its `StasisStart` follows `snoopStasisAfterMs` later, or never when that is `null`.
   */
  private snoop(spiedId: string, body: unknown): RouteResult {
    const params = body as { snoopId?: string; appArgs?: string };
    const snoopChannel = defaultChannel({ id: params.snoopId });
    this.channels.set(snoopChannel.id, snoopChannel);
    this.snoopsOutsideStasis.add(snoopChannel.id);
    if (this.snoopStasisAfterMs !== null) {
      setTimeout(() => {
        this.emit({
          type: 'StasisStart',
          timestamp: new Date().toISOString(),
          application: 'zamfono',
          args: (params.appArgs ?? `snoop,${spiedId}`).split(','),
          channel: snoopChannel
        });
      }, this.snoopStasisAfterMs);
    }
    return { status: HTTP_OK, body: snoopChannel };
  }

  private route(
    method: string,
    path: string,
    body: unknown,
    qs: string
  ): RouteResult {
    if (path === 'channels' && method === 'POST') {
      return this.originate(body);
    }
    if (path === 'channels' && method === 'GET') {
      return { status: HTTP_OK, body: [...this.channels.values()] };
    }
    if (path.startsWith('channels/')) {
      const { id, action } = splitResource(path, 'channels/');
      return this.routeChannel(method, id, action, body, qs);
    }
    if (path === 'bridges' || path.startsWith('bridges/')) {
      return routeBridge(this.bridges, method, path, body);
    }
    if (path.startsWith('playbacks/') && method === 'DELETE') {
      return this.playbacks.stop(path.slice('playbacks/'.length));
    }
    return routeMisc(method, path, this.endpoints);
  }

  private originate(body: unknown): RouteResult {
    if (this.failOriginate) {
      return {
        status: this.failOriginate.status,
        body: { message: 'Failed to originate channel' }
      };
    }
    const params = body as {
      channelId?: string;
      endpoint?: string;
      callerId?: string;
    };
    const channel = defaultChannel({
      id: params.channelId,
      name: params.endpoint,
      caller: { number: params.callerId ?? '', name: '' }
    });
    this.channels.set(channel.id, channel);
    this.onOriginate?.(channel);
    setTimeout(() => {
      channel.state = 'Up';
      this.emit({
        type: 'ChannelStateChange',
        timestamp: new Date().toISOString(),
        application: 'zamfono',
        channel
      });
    }, this.answerAfterMs);
    return { status: HTTP_OK, body: channel };
  }

  private routeChannel(
    method: string,
    id: string,
    action: string,
    body: unknown,
    qs: string
  ): RouteResult {
    const channel = this.channels.get(id);
    if (!channel) {
      return { status: HTTP_NOT_FOUND, body: { message: 'Channel not found' } };
    }
    if (action === '' && method === 'DELETE') {
      this.channels.delete(id);
      return { status: HTTP_OK, body: {} };
    }
    if (action === 'play' && method === 'POST') {
      return this.playbacks.start(body);
    }
    if (action === 'snoop' && method === 'POST') {
      return this.snoop(id, body);
    }
    if (action === 'rtp_statistics' && method === 'GET') {
      return readRtpStatistics(this.rtpStatistics, id);
    }
    if (method === 'GET' && action === 'variable') {
      return readChannelVariable(this.channelVariables, id, qs);
    }
    if (method === 'POST' && action === 'record') {
      if (this.snoopsOutsideStasis.has(id)) {
        return {
          status: HTTP_CONFLICT,
          body: { message: 'Channel not in Stasis application' }
        };
      }
      scheduleRecordingFinished(this, body);
      return { status: HTTP_OK, body: {} };
    }
    if (ACKED_CHANNEL_ACTIONS.has(`${method} ${action}`)) {
      return { status: HTTP_OK, body: {} };
    }
    return { status: HTTP_NOT_FOUND, body: { message: 'Not found' } };
  }
}
