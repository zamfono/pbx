import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { defaultChannel, type AriEvent, type Channel } from '../ari/types.js';
import {
  DeviceRinger,
  showRinging,
  type Device,
  type DeviceRing,
  type RingAri
} from './deviceRing.js';

/** Originates that resolve only when the test says so, over an event stream it drives. */
class ScriptedAri extends EventEmitter implements RingAri {
  readonly hungUp: string[] = [];
  private readonly pendingOriginates = new Map<string, () => void>();

  readonly channels: RingAri['channels'] = {
    originate: params =>
      new Promise<Channel>(resolve => {
        const channel = defaultChannel({ id: params.channelId });
        this.pendingOriginates.set(channel.id, () => {
          resolve(channel);
        });
      }),
    hangup: id => {
      this.hungUp.push(id);
      return Promise.resolve();
    }
  };

  /** Lets Asterisk's originate response for `channelId` arrive. */
  completeOriginate(channelId: string): void {
    this.pendingOriginates.get(channelId)?.();
    this.pendingOriginates.delete(channelId);
  }

  answer(channelId: string): void {
    const event: AriEvent = {
      type: 'ChannelStateChange',
      timestamp: new Date().toISOString(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId, state: 'Up' })
    };
    this.emit('event', event);
  }

  destroy(channelId: string): void {
    const event: AriEvent = {
      type: 'ChannelDestroyed',
      timestamp: new Date().toISOString(),
      application: 'zamfono',
      channel: defaultChannel({ id: channelId })
    };
    this.emit('event', event);
  }
}

/** Only `sipUsername` is read by a ring; the rest of the row is never looked at. */
function device(sipUsername: string): Device {
  const deletedAt: string | null = null;
  return { sipUsername, userId: 'user-1', deletedAt } as Device;
}

function settleMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

type Outcome = { answered: string[]; unanswered: number };

function ringOf(channelIds: string[], outcome: Outcome): DeviceRing {
  return {
    channelIds: new Set(channelIds),
    onAnswer: channel => {
      outcome.answered.push(channel.id);
      return Promise.resolve();
    },
    onUnanswered: () => {
      outcome.unanswered += 1;
      return Promise.resolve();
    }
  };
}

const PARAMS = {
  appArgs: 'click,call-1',
  callerId: '101',
  timeoutS: 25,
  language: 'en'
};

describe('DeviceRinger', () => {
  it('settles on the first answer even while another originate is still in flight, and hangs that one up on arrival', async () => {
    const ari = new ScriptedAri();
    const ringer = new DeviceRinger(ari);
    const outcome: Outcome = { answered: [], unanswered: 0 };
    const ring = ringOf(['chan-a', 'chan-b'], outcome);

    const done = ringer.ring(
      [device('e101-a'), device('e101-b')],
      ring,
      PARAMS
    );
    ari.completeOriginate('chan-a');
    await settleMicrotasks();
    ari.answer('chan-a');
    await settleMicrotasks();
    expect(outcome.answered).toEqual(['chan-a']);
    // chan-b's hangup from the settle could not reach a channel Asterisk had not created yet.
    expect(ari.hungUp).toEqual(['chan-b']);

    ari.completeOriginate('chan-b');
    await done;
    expect(outcome.unanswered).toBe(0);
    expect(outcome.answered).toEqual(['chan-a']);
    expect(ari.hungUp).toEqual(['chan-b', 'chan-b']);

    // A straggling answer or hangup of a settled ring changes nothing.
    ari.answer('chan-b');
    ari.destroy('chan-b');
    await settleMicrotasks();
    expect(outcome.answered).toEqual(['chan-a']);
    expect(outcome.unanswered).toBe(0);
  });

  it('is unanswered exactly once when every device ends without answering', async () => {
    const ari = new ScriptedAri();
    const ringer = new DeviceRinger(ari);
    const outcome: Outcome = { answered: [], unanswered: 0 };
    const ring = ringOf(['chan-a', 'chan-b'], outcome);

    const done = ringer.ring(
      [device('e101-a'), device('e101-b')],
      ring,
      PARAMS
    );
    ari.completeOriginate('chan-a');
    ari.completeOriginate('chan-b');
    await done;
    ari.destroy('chan-a');
    ari.destroy('chan-b');
    await settleMicrotasks();
    expect(outcome.unanswered).toBe(1);
    expect(outcome.answered).toEqual([]);
    expect(ari.hungUp).toEqual([]);
  });

  it('is unanswered once when every originate fails, and a stopped ring never fires a hook', async () => {
    const ari = new ScriptedAri();
    const ringer = new DeviceRinger(ari);
    const failed: Outcome = { answered: [], unanswered: 0 };
    const failing = ringOf(['chan-a'], failed);
    ari.channels.originate = () => Promise.reject(new Error('503'));
    await ringer.ring([device('e101-a')], failing, PARAMS);
    expect(failed.unanswered).toBe(1);

    const stopped: Outcome = { answered: [], unanswered: 0 };
    const ring = ringOf(['chan-b'], stopped);
    ari.channels.originate = params =>
      Promise.resolve(defaultChannel({ id: params.channelId }));
    await ringer.ring([device('e101-b')], ring, PARAMS);
    await ringer.stop(ring, null);
    expect(ari.hungUp).toEqual(['chan-b']);
    ari.destroy('chan-b');
    ari.answer('chan-b');
    await settleMicrotasks();
    expect(stopped).toEqual({ answered: [], unanswered: 0 });
  });
});

describe('showRinging', () => {
  /** The presence transitions a ring sets, as `state@key`. */
  function presenceLog(): {
    states: string[];
    presence: Parameters<typeof showRinging>[0];
  } {
    const states: string[] = [];
    return {
      states,
      presence: {
        setCallState: (userId, state, peer, _group, key) => {
          states.push(`${userId}:${state}:${peer ?? ''}@${key ?? ''}`);
        }
      }
    };
  }

  const USER = { userId: 'user-1', peer: '+15559999', key: 'call-1' };

  it('shows the user ringing while the ring runs and idle once a device answers (§9.3)', async () => {
    const ari = new ScriptedAri();
    const ringer = new DeviceRinger(ari);
    const outcome: Outcome = { answered: [], unanswered: 0 };
    const { states, presence } = presenceLog();
    const ring: DeviceRing = {
      channelIds: new Set(['chan-a']),
      ...showRinging(presence, USER, ringOf(['chan-a'], outcome))
    };
    expect(states).toEqual(['user-1:ringing:+15559999@call-1']);

    const done = ringer.ring([device('e101-a')], ring, PARAMS);
    ari.completeOriginate('chan-a');
    await done;
    ari.answer('chan-a');
    await settleMicrotasks();

    expect(outcome.answered).toEqual(['chan-a']);
    expect(states).toEqual([
      'user-1:ringing:+15559999@call-1',
      'user-1:idle:@call-1'
    ]);
  });

  it('returns the user to idle when no device answers (§9.3)', async () => {
    const ari = new ScriptedAri();
    const ringer = new DeviceRinger(ari);
    const outcome: Outcome = { answered: [], unanswered: 0 };
    const { states, presence } = presenceLog();
    const ring: DeviceRing = {
      channelIds: new Set(['chan-a']),
      ...showRinging(presence, USER, ringOf(['chan-a'], outcome))
    };

    const done = ringer.ring([device('e101-a')], ring, PARAMS);
    ari.completeOriginate('chan-a');
    await done;
    ari.destroy('chan-a');
    await settleMicrotasks();

    expect(outcome.unanswered).toBe(1);
    expect(states.at(-1)).toBe('user-1:idle:@call-1');
  });
});
