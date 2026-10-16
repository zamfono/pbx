/**
 * The voice bots' streams in progress (§9.4 "WebSocket targets"): one listener on ARI's event
 * stream hands each its caller's DTMF and its media channel's end, and a session token is looked
 * up here, so it works exactly while its stream lasts (§5.2 "Session tokens"). The address the
 * media channels stream to is `core`'s own on the network it reaches Asterisk over, found once.
 */
import dgram from 'node:dgram';

import type { AriClient } from '../ari/client.js';
import { isEvent, type AriEvent } from '../ari/events.js';
import { sessionTokenHash, type BotSession } from './botSession.js';

// Any port: connecting a UDP socket only picks the route, it sends nothing.
const DISCARD_PORT = 9;

/** The address of `core` a packet to `host` leaves from. */
export async function ownAddressTowards(host: string): Promise<string> {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(DISCARD_PORT, host, () => {
        resolve();
      });
    });
    return socket.address().address;
  } finally {
    socket.close();
  }
}

export class BotSessions {
  private readonly byMediaChannel = new Map<string, BotSession>();
  private readonly byTokenHash = new Map<string, BotSession>();
  private readonly asteriskHost: string;
  private ownAddress: Promise<string> | null = null;

  /** `asteriskHost` is the ARI URL's host: Asterisk, which the media channels stream from. */
  constructor(ari: AriClient, asteriskHost: string) {
    this.asteriskHost = asteriskHost;
    ari.on('event', (ev: AriEvent) => {
      this.onEvent(ev);
    });
  }

  /** `core`'s own address towards Asterisk, looked up again after a failed lookup. */
  mediaAddress(): Promise<string> {
    this.ownAddress ??= ownAddressTowards(this.asteriskHost).catch(
      (error: unknown) => {
        this.ownAddress = null;
        throw error;
      }
    );
    return this.ownAddress;
  }

  add(session: BotSession): void {
    this.byMediaChannel.set(session.leg.channelId, session);
    this.byTokenHash.set(sessionTokenHash(session.token), session);
  }

  /** The call and bot leg the session token hashed to `hash` acts for, while its stream lasts. */
  resolve(hash: string): { callId: string; legId: string } | null {
    const session = this.byTokenHash.get(hash);
    return session === undefined
      ? null
      : { callId: session.call.id, legId: session.leg.id };
  }

  /** Ends `session`: its token stops working and its socket closes. */
  end(session: BotSession): void {
    this.byMediaChannel.delete(session.leg.channelId);
    this.byTokenHash.delete(sessionTokenHash(session.token));
    session.end();
  }

  private onEvent(ev: AriEvent): void {
    if (isEvent(ev, 'ChannelDestroyed')) {
      const session = this.byMediaChannel.get(ev.channel.id);
      if (session !== undefined) {
        this.end(session);
      }
      return;
    }
    if (isEvent(ev, 'ChannelDtmfReceived')) {
      for (const session of this.byMediaChannel.values()) {
        if (session.call.callerChannelId === ev.channel.id) {
          session.dtmf(ev.digit, ev.duration_ms ?? 0);
        }
      }
    }
  }
}
