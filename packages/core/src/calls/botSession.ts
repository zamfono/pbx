/**
 * One voice bot's stream (§9.4 "WebSocket targets"): the AudioSocket connection of the call's
 * `externalMedia` channel (`botAudioSocket.ts`), and the bot's WebSocket, the protocol
 * (`botProtocols.ts`) between them. The caller's audio goes to the bot as it arrives, dropped while the socket cannot
 * keep up; the bot's audio is played back in 20 ms frames (`botPlayout.ts`). The bot closing its
 * socket hangs up the media channel, whose end then ends the bot's leg as any answered leg's
 * would (`legsEnded.ts`); the media channel ending, however it ends, closes the socket.
 */
import { createHash, randomBytes } from 'node:crypto';
import type net from 'node:net';
import type WebSocket from 'ws';

import { SESSION_TOKEN_PREFIX } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { logUnlessGone } from '../ari/failures.js';
import type { Logger } from '../ari/types.js';
import {
  audioSocketMessage,
  AudioSocketReader,
  isAudio,
  type MediaEncoding
} from './botAudioSocket.js';
import { Playout } from './botPlayout.js';
import type { BotFrame, BotProtocol, BotStart } from './botProtocols.js';
import type { Call, Leg } from './call.js';

// A session token: the prefix `api` tells it by, then 256 random bits (§5.2 "Session tokens").
const SESSION_TOKEN_BYTES = 32;
// What the socket may hold unsent before the caller's audio is dropped rather than queued: about
// ten seconds of the widest stream, 24 kHz linear as base64 or binary.
const MAX_BUFFERED_BYTES = 1_048_576;

/** The SHA-256 a session token is looked up by, so `core` never compares the token itself. */
export function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A `ws` message as one buffer. */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export type BotSessionParams = {
  call: Call;
  leg: Leg;
  socket: WebSocket;
  /** The media channel's AudioSocket connection, past its UUID. */
  media: net.Socket;
  encoding: MediaEncoding;
  protocol: BotProtocol;
  /** What the bot is told at the start, but the token and the leg ids this adds. */
  start: BotStart;
  ari: Pick<AriClient, 'channels'>;
  log: Logger;
};

export class BotSession {
  readonly call: Call;
  readonly leg: Leg;
  /** The token the bot acts on its call with, while the session lasts (§5.2 "Session tokens"). */
  readonly token = `${SESSION_TOKEN_PREFIX}${randomBytes(SESSION_TOKEN_BYTES).toString('base64url')}`;
  private readonly params: BotSessionParams;
  private readonly playout: Playout;
  private startedAtMs = 0;
  private ended = false;

  constructor(params: BotSessionParams) {
    this.params = params;
    this.call = params.call;
    this.leg = params.leg;
    const fields = { callId: params.call.id };
    this.playout = new Playout({
      frameBytes: params.encoding.frameBytes,
      send: frame => {
        params.media.write(audioSocketMessage(params.encoding.kind, frame));
      },
      marked: marker => {
        this.send(params.protocol.marked(marker));
      },
      dropped: bytes => {
        params.log.warn({ ...fields, bytes }, 'voice bot audio dropped');
      }
    });
  }

  /** Starts the stream: the protocol's opening frames, then audio both ways. */
  start(): void {
    const { params } = this;
    this.startedAtMs = Date.now();
    for (const frame of params.protocol.start({
      ...params.start,
      parameters: {
        ...params.start.parameters,
        sessionToken: this.token,
        callerLegId: this.call.callerLegId,
        botLegId: this.leg.id
      }
    })) {
      this.send(frame);
    }
    const reader = new AudioSocketReader();
    params.media.on('data', (chunk: Buffer) => {
      for (const message of reader.push(chunk)) {
        if (isAudio(message) && message.payload.length > 0) {
          this.toBot(message.payload);
        }
      }
    });
    // Paused since its UUID was read (`webSocketTarget.ts`).
    params.media.resume();
    params.socket.on('message', (data: WebSocket.RawData, isBinary) => {
      this.fromBot(toBuffer(data), isBinary);
    });
    // The bot hung up.
    params.socket.on('close', () => {
      if (!this.ended) {
        this.hangUp();
      }
    });
    params.socket.on('error', (error: Error) => {
      params.log.warn(
        { err: error, callId: this.call.id },
        'voice bot socket failed'
      );
    });
    this.playout.start();
  }

  /** A DTMF digit the caller pressed. */
  dtmf(digit: string, durationMs: number): void {
    this.send(this.params.protocol.dtmf(digit, durationMs));
  }

  /** The media channel ended: the bot is told, where its protocol says so, and the socket closes. */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.playout.stop();
    const stop = this.params.protocol.stop();
    if (stop !== null) {
      this.send(stop);
    }
    this.params.socket.close();
    this.params.media.destroy();
  }

  /** Hangs up the media channel, whose end then ends the bot's leg and closes the socket. */
  hangUp(): void {
    this.params.ari.channels.hangup(this.leg.channelId).catch(
      logUnlessGone(this.params.log, 'voice bot media hangup', {
        callId: this.call.id
      })
    );
  }

  private toBot(payload: Buffer): void {
    if (this.params.socket.bufferedAmount <= MAX_BUFFERED_BYTES) {
      this.send(
        this.params.protocol.media(payload, Date.now() - this.startedAtMs)
      );
    }
  }

  private fromBot(data: Buffer, isBinary: boolean): void {
    const command = this.params.protocol.parse(data, isBinary);
    if (command?.kind === 'audio') {
      this.playout.push(command.payload);
    } else if (command?.kind === 'mark') {
      this.playout.mark(command.marker);
    } else if (command?.kind === 'clear') {
      for (const frame of this.params.protocol.cleared(this.playout.clear())) {
        this.send(frame);
      }
    }
  }

  private send(frame: BotFrame): void {
    const { socket } = this.params;
    if (socket.readyState === socket.OPEN) {
      socket.send(frame);
    }
  }
}
