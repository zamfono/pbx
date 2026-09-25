/**
 * The device ring an action starts on a user's own phones (§10.2 "Click-to-dial": "rings the
 * user's devices first"; §10.1 "Pickup" over the API): every live device is originated into the
 * app, the first to answer wins, the others are hung up. A ring whose every device fails or ends
 * without answering is unanswered. Its own module keeps `actions.ts` under the repository's
 * `max-lines` lint rule.
 */
import type { AriClient } from '../ari/client.js';
import type { AriEvent, Channel } from '../ari/types.js';
import type { Snapshot } from '../internal/server.js';
import type { Presence } from '../presence.js';
import { channelLanguageVariable } from '../prompts.js';

export type Device = Snapshot['devices'][number];

/** The slice of the ARI client a ring needs: its event stream and channel originate/hangup. */
export type RingAri = {
  on: (event: 'event', listener: (ev: AriEvent) => void) => unknown;
  channels: Pick<AriClient['channels'], 'originate' | 'hangup'>;
};

/** One ring's hooks: the winning channel, or no device answering. */
export type RingHooks = {
  onAnswer: (channel: Channel) => Promise<void>;
  onUnanswered: () => Promise<void>;
};

export type RingParams = {
  appArgs: string;
  callerId: string;
  timeoutS: number;
  // §9.1 "every channel's language", set from the leg's creation.
  language: string;
};

export type DeviceRing = RingHooks & { channelIds: Set<string> };

/** Whose phones a ring shows ringing, with what, under which per-call presence key. */
export type RingingUser = { userId: string; peer: string; key: string };

/**
 * §9.3 "a user: RINGING while any of their devices rings": shows `user` ringing from now until
 * the ring settles, answered or not, and hands `hooks` on to run once it has. A ring stopped
 * outright fires neither hook; its caller clears the state it keyed under `user.key` itself.
 */
export function showRinging(
  presence: Pick<Presence, 'setCallState'> | null,
  user: RingingUser,
  hooks: RingHooks
): RingHooks {
  if (presence === null) {
    return hooks;
  }
  const { userId, peer, key } = user;
  presence.setCallState(userId, 'ringing', peer, null, key);
  const stopRinging = (): void => {
    presence.setCallState(userId, 'idle', null, null, key);
  };
  return {
    onAnswer: channel => {
      stopRinging();
      return hooks.onAnswer(channel);
    },
    onUnanswered: () => {
      stopRinging();
      return hooks.onUnanswered();
    }
  };
}

/** How a ring ended: the winner's channel id, or `null` for unanswered and stopped rings. */
type Outcome = string | null;

/** Runs device rings over one ARI connection, settling each from the event stream. */
export class DeviceRinger {
  private readonly ari: RingAri;
  private readonly rings = new Map<string, DeviceRing>();
  // A ring settles exactly once, whichever arrives first: the winner's answer, the last device
  // ending, or a stop. Everything that lands afterwards, a late originate response, a straggler's
  // events, is judged against the recorded outcome and never fires a hook again.
  private readonly outcomes = new WeakMap<DeviceRing, Outcome>();

  constructor(ari: RingAri) {
    this.ari = ari;
    ari.on('event', (ev: AriEvent) => {
      this.onEvent(ev);
    });
  }

  /**
   * Originates every device with the ring's pre-assigned channel ids (`channelIds`, one per
   * device, registered before the first originate so an early answer is never missed). A device
   * that fails to originate leaves the ring; a ring with no device left is unanswered at once. A
   * device whose originate completes after the ring already settled for another channel is hung
   * up, since the settle's own hangup could not reach a channel Asterisk had not created yet.
   */
  async ring(
    devices: Device[],
    ring: DeviceRing,
    params: RingParams
  ): Promise<void> {
    const channelIds = [...ring.channelIds];
    for (const channelId of channelIds) {
      this.rings.set(channelId, ring);
    }
    await Promise.all(
      devices.map((device, index) => {
        const channelId = channelIds.at(index) ?? '';
        return this.ari.channels
          .originate({
            endpoint: `PJSIP/${device.sipUsername}`,
            app: 'zamfono',
            appArgs: params.appArgs,
            callerId: params.callerId,
            timeout: params.timeoutS,
            variables: channelLanguageVariable(params.language),
            channelId
          })
          .then(() => this.hangupLateLoser(ring, channelId))
          .catch(() => {
            this.rings.delete(channelId);
            ring.channelIds.delete(channelId);
          });
      })
    );
    if (ring.channelIds.size === 0 && this.settle(ring, null)) {
      await ring.onUnanswered();
    }
  }

  /** Takes every channel of `ring` out of the race and hangs up all but `winner`. */
  async stop(ring: DeviceRing, winner: string | null): Promise<void> {
    this.settle(ring, winner);
    const losers = [...ring.channelIds].filter(id => id !== winner);
    for (const channelId of ring.channelIds) {
      this.rings.delete(channelId);
    }
    ring.channelIds.clear();
    await Promise.all(
      losers.map(id => this.ari.channels.hangup(id).catch(() => undefined))
    );
  }

  /** Records `outcome` for `ring`; `false` when the ring had already settled. */
  private settle(ring: DeviceRing, outcome: Outcome): boolean {
    if (this.outcomes.has(ring)) {
      return false;
    }
    this.outcomes.set(ring, outcome);
    return true;
  }

  private async hangupLateLoser(
    ring: DeviceRing,
    channelId: string
  ): Promise<void> {
    const outcome = this.outcomes.get(ring);
    if (outcome === undefined || outcome === channelId) {
      return;
    }
    await this.ari.channels.hangup(channelId).catch(() => undefined);
  }

  private onEvent(ev: AriEvent): void {
    const channel = ev.channel as Channel | undefined;
    const ring = channel === undefined ? undefined : this.rings.get(channel.id);
    if (channel === undefined || ring === undefined) {
      return;
    }
    // ARI reports the device answering as `ChannelStateChange` Up and, for a channel originated
    // into the app, as its `StasisStart`; the first of the two settles the ring.
    const answered =
      ev.type === 'StasisStart' ||
      (ev.type === 'ChannelStateChange' && channel.state === 'Up');
    if (answered) {
      if (this.outcomes.has(ring)) {
        return;
      }
      this.stop(ring, channel.id)
        .then(() => ring.onAnswer(channel))
        .catch(() => undefined);
      return;
    }
    if (ev.type === 'ChannelDestroyed') {
      this.rings.delete(channel.id);
      ring.channelIds.delete(channel.id);
      if (ring.channelIds.size === 0 && this.settle(ring, null)) {
        ring.onUnanswered().catch(() => undefined);
      }
    }
  }
}
