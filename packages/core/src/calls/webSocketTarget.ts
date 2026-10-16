/**
 * §10.1 step 7's `webSocket` target (§9.4 "WebSocket targets"): the call handed to a voice bot,
 * which answers it. The bot's WebSocket is opened while the caller still waits, then an
 * `externalMedia` channel streams the call's audio over AudioSocket to a TCP server of `core`'s
 * own; the channel is the bot's leg, claimed and bridged with the caller as any answer is
 * (`answer.ts`), so recording, the live calls and the history treat it as an answered leg, and
 * the stream starts (`botSession.ts`). A socket that does not open, or media that cannot be set
 * up, releases the call with 503 as a `sip` target that cannot be dialled does.
 */
import net from 'node:net';
import WebSocket from 'ws';

import { newId } from '@zamfono/shared';

import { logUnlessGone } from '../ari/failures.js';
import type { ForwardTarget } from '../routing/targets.js';
import { SIP_SERVICE_UNAVAILABLE } from '../sipCodes.js';
import { bridgeAnswered, claimAnswer } from './answer.js';
import { waitForStasisEntry } from './ariWaits.js';
import {
  AudioSocketReader,
  mediaEncoding,
  UUID_KIND,
  uuidBytes,
  type MediaEncoding
} from './botAudioSocket.js';
import { botProtocol } from './botProtocols.js';
import { BotSession } from './botSession.js';
import type { Call, Leg } from './call.js';
import { recordingOf, standInOf, type Forwarder } from './forwardLeg.js';
import { callerNameOf, forwardValues } from './forwardValues.js';
import type { Pipeline } from './pipeline.js';
import { release } from './release.js';

type WebSocketTarget = Extract<ForwardTarget, { kind: 'webSocket' }>;

// How long the bot's socket may take to open, and the media channel to connect and enter the app.
const CONNECT_TIMEOUT_MS = 10_000;
const MEDIA_WAIT_MS = 5000;
// The largest frame a bot may send: well above a second of 24 kHz linear audio as base64.
const MAX_FRAME_BYTES = 1_048_576;

/** Opens `url`, resolving with the open socket, or `null` once it fails or times out. */
function connect(url: string): Promise<WebSocket | null> {
  const socket = new WebSocket(url, {
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    maxPayload: MAX_FRAME_BYTES
  });
  return new Promise(resolve => {
    socket.once('open', () => {
      resolve(socket);
    });
    socket.once('error', () => {
      resolve(null);
    });
    socket.once('close', () => {
      resolve(null);
    });
  });
}

/** A TCP server listening on an ephemeral port. */
async function listen(): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

/**
 * The connection to `server` that opens with `uuid`'s message, as `chan_audiosocket` opens its
 * own, what followed it put back; `null` after `ms`. Any other connection is dropped, so only
 * the channel `core` asked for streams here.
 */
function acceptMedia(
  server: net.Server,
  uuid: string,
  ms: number
): Promise<net.Socket | null> {
  const expected = uuidBytes(uuid);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    timer.unref();
    server.on('connection', socket => {
      const reader = new AudioSocketReader();
      socket.on('error', () => undefined);
      const onData = (chunk: Buffer): void => {
        const [first] = reader.push(chunk);
        if (first === undefined) {
          return;
        }
        socket.off('data', onData);
        if (first.kind !== UUID_KIND || !first.payload.equals(expected)) {
          socket.destroy();
          return;
        }
        socket.pause();
        socket.unshift(reader.rest());
        clearTimeout(timer);
        resolve(socket);
      };
      socket.on('data', onData);
    });
  });
}

type Media = { channelId: string; socket: net.Socket };

/**
 * The `externalMedia` channel streaming `encoding` over AudioSocket to a fresh TCP server, in
 * the app and connected; `null` when any step fails, nothing left behind. The channel's id is the
 * UUID the connection names it by.
 */
async function openMedia(
  pipeline: Pipeline,
  call: Call,
  encoding: MediaEncoding
): Promise<Media | null> {
  const { ari, bots, logger } = pipeline.deps;
  const server = await listen();
  const channelId = newId();
  const stasis = waitForStasisEntry(ari, channelId, MEDIA_WAIT_MS);
  const accepted = acceptMedia(server, channelId, MEDIA_WAIT_MS);
  const port = (server.address() as net.AddressInfo).port;
  try {
    await ari.channels.externalMedia({
      app: 'zamfono',
      channelId,
      external_host: `${await bots.mediaAddress()}:${String(port)}`,
      format: encoding.format,
      encapsulation: 'audiosocket',
      transport: 'tcp',
      data: channelId
    });
  } catch (error) {
    stasis.settle('gone');
    server.close();
    // A connection made before the request failed has no channel to stream.
    accepted.then(
      socket => socket?.destroy(),
      () => undefined
    );
    logger.warn({ err: error, callId: call.id }, 'voice bot media failed');
    return null;
  }
  const [entered, socket] = await Promise.all([stasis.promise, accepted]);
  server.close();
  if (entered !== 'entered' || socket === null) {
    socket?.destroy();
    await ari.channels
      .hangup(channelId)
      .catch(
        logUnlessGone(logger, 'voice bot media hangup', { callId: call.id })
      );
    return null;
  }
  return { channelId, socket };
}

/** What the bot is told of the call (§9.4 "WebSocket targets"): every value a `sip` target's
 * header templates can name that is not empty, and where the stack's API is. */
async function metadata(
  pipeline: Pipeline,
  call: Call
): Promise<Record<string, string>> {
  const snapshot = await pipeline.deps.cache.get();
  const values = forwardValues(
    call,
    [...call.diversions],
    snapshot,
    await callerNameOf(pipeline, call, snapshot)
  );
  return {
    ...Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== '')
    ),
    apiUrl: `https://${pipeline.deps.stackFqdn}/api/v1`
  };
}

/** Undoes a set-up that the caller hanging up, or a failure, cut short. */
async function abandon(
  pipeline: Pipeline,
  call: Call,
  socket: WebSocket | null,
  media: Media | null
): Promise<void> {
  socket?.close();
  if (media !== null) {
    media.socket.destroy();
    await pipeline.deps.ari.channels.hangup(media.channelId).catch(
      logUnlessGone(pipeline.deps.logger, 'voice bot media hangup', {
        callId: call.id
      })
    );
  }
}

/**
 * Hands `call` to the bot `target` names (§9.4 "WebSocket targets"): its leg stands in for a
 * forwarder whose unconditional rule it is and records when the target records (§10.2 "Effective
 * flag"), as an external or SIP target's trunk leg does.
 */
export async function dialWebSocketTarget(
  pipeline: Pipeline,
  call: Call,
  target: WebSocketTarget,
  forwarder: Forwarder | null
): Promise<void> {
  const encoding = mediaEncoding(target.sampleRate);
  const socket = await connect(target.url);
  const media =
    socket === null || call.callerEnded === true
      ? null
      : await openMedia(pipeline, call, encoding);
  if (call.callerEnded === true) {
    await abandon(pipeline, call, socket, media);
    return;
  }
  if (socket === null || media === null) {
    call.log.event({
      event: 'webSocket',
      protocol: target.protocol,
      cause: socket === null ? 'connectFailed' : 'mediaFailed'
    });
    await abandon(pipeline, call, socket, media);
    await release(pipeline, call, SIP_SERVICE_UNAVAILABLE, 'failed');
    return;
  }
  const leg: Leg = {
    id: newId(),
    channelId: media.channelId,
    kind: 'webSocket',
    userId: null,
    state: 'up',
    endCause: null,
    ...standInOf(forwarder),
    ...recordingOf(target)
  };
  const { ari, bots, logger } = pipeline.deps;
  const session = new BotSession({
    call,
    leg,
    socket,
    media: media.socket,
    encoding,
    protocol: botProtocol(target.protocol),
    start: {
      callId: call.id,
      accountId: pipeline.deps.stackFqdn,
      sampleRate: target.sampleRate,
      parameters: await metadata(pipeline, call)
    },
    ari,
    log: logger
  });
  // Tracked before the bridge, so the media channel's end closes the socket however it comes.
  bots.add(session);
  // Its end then closes the socket (`BotSessions`).
  if (!claimAnswer(pipeline, call, leg, { protocol: target.protocol })) {
    session.hangUp();
    return;
  }
  if (await bridgeAnswered(pipeline, call, leg)) {
    session.start();
    return;
  }
  // The media channel may have gone before the session was tracked.
  bots.end(session);
}
