/**
 * §7 level `sip`: Asterisk mirrors a call's SIP messages to `core` over HEP, which carries the
 * Call-ID and nothing that names the call. Each channel's own `CHANNEL(pjsip,call-id)` is the
 * join: the caller's when the call opens and every leg's as it is created, before its dial sends
 * the INVITE (`legOriginate.ts`), dropped when the call closes, so a message can only reach a call
 * that is still open.
 *
 * A dialog's first messages can race its join: the caller's INVITE and early responses reach the
 * collector before the channel enters Stasis, and below level `sip` a leg is dialled without
 * waiting for its join. A message for no known Call-ID is therefore held briefly and handed to
 * the call its Call-ID joins within that time; anything else (a REGISTER, an OPTIONS ping, a
 * dialog of no call) ages out.
 */
import type { AriClient } from './ari/client.js';
import type { Call } from './calls/call.js';

/** One mirrored SIP message, as the HEP listener parsed it. */
export type SipMessage = {
  callId: string;
  at: string;
  direction: 'in' | 'out';
  payload: string;
};

// How long an unmatched message waits for its Call-ID to be joined: the join is one ARI read
// after StasisStart or a leg's create, so seconds cover it with a wide margin.
const HOLD_MS = 5000;
// A ceiling on held messages, so a burst of traffic belonging to no call cannot grow the queue
// without limit before it ages out.
const HOLD_MAX_MESSAGES = 1000;

type HeldMessage = { receivedAt: number; message: SipMessage };

/** Appends `message` to `call`'s log, which keeps it if the call's level is `sip` (§7). */
function append(call: Call, message: SipMessage): void {
  call.log.sip({
    at: message.at,
    direction: message.direction,
    raw: message.payload
  });
}

export class SipCapture {
  private readonly ari: AriClient;
  private readonly now: () => number;
  private readonly callsByCallId = new Map<string, Call>();
  // Unmatched messages in arrival order, oldest first.
  private held: HeldMessage[] = [];

  constructor(ari: AriClient, now: () => number = Date.now) {
    this.ari = ari;
    this.now = now;
  }

  /** Whether a Call-ID is registered; the HEP correlation's own test seam. */
  knowsCallId(callId: string): boolean {
    return this.callsByCallId.has(callId);
  }

  /** Appends one mirrored SIP message to its call's log, holding one whose call is not known yet. */
  message(message: SipMessage): void {
    const call = this.callsByCallId.get(message.callId);
    if (call !== undefined) {
      append(call, message);
      return;
    }
    this.prune();
    this.held.push({ receivedAt: this.now(), message });
    if (this.held.length > HOLD_MAX_MESSAGES) {
      this.held.shift();
    }
  }

  /** Joins `channelId`'s SIP dialog to `call`, handing it the messages held for that dialog;
   *  resolves once the join is in place, with the dialog's Call-ID, or with null for a channel
   *  that has none, which a caller may wait for. */
  register(call: Call, channelId: string): Promise<string | null> {
    return this.ari.channels
      .getVariable(channelId, 'CHANNEL(pjsip,call-id)')
      .then(callId => {
        if (callId === null || callId === '') {
          return null;
        }
        this.callsByCallId.set(callId, call);
        this.release(callId, call);
        return callId;
      });
  }

  /** Drops every Call-ID joined to `call`, once it has closed. */
  forget(call: Call): void {
    for (const [callId, open] of this.callsByCallId) {
      if (open.id === call.id) {
        this.callsByCallId.delete(callId);
      }
    }
  }

  /** Hands `call` the held messages of `callId`, in the order they arrived. */
  private release(callId: string, call: Call): void {
    this.prune();
    const remaining: HeldMessage[] = [];
    for (const entry of this.held) {
      if (entry.message.callId === callId) {
        append(call, entry.message);
      } else {
        remaining.push(entry);
      }
    }
    this.held = remaining;
  }

  /** Drops held messages older than `HOLD_MS`. */
  private prune(): void {
    const cutoff = this.now() - HOLD_MS;
    const firstFresh = this.held.findIndex(entry => entry.receivedAt > cutoff);
    if (firstFresh !== 0) {
      this.held = firstFresh === -1 ? [] : this.held.slice(firstFresh);
    }
  }
}
