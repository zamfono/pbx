import { describe, expect, it } from 'vitest';

import { AriClient } from '../ari/client.js';
import { StateStore } from '../internal/stateStore.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { TrunkChannels } from './trunkChannels.js';

describe('TrunkChannels', () => {
  it("serves each trunk's channels in use in the live state until it carries none (§7, §9.4)", () => {
    const state = new StateStore();
    // Never connected: counting a leg reads no ARI event.
    const ari = new AriClient({
      url: 'http://127.0.0.1:1',
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    const trunkChannels = new TrunkChannels({ ari, state });

    trunkChannels.noteAttemptStarted('trunkA', 'a1');
    trunkChannels.noteAttemptStarted('trunkA', 'a2');
    trunkChannels.noteAttemptStarted('trunkB', 'b1');
    trunkChannels.noteAttemptEnded('b1');

    expect(state.snapshot().trunkChannels).toEqual({ trunkA: 2 });
    expect(trunkChannels.activeChannels('trunkA')).toBe(2);

    // A leg seen ending twice (its placement failing and its channel's end) counts off once.
    trunkChannels.noteAttemptEnded('a1');
    trunkChannels.noteAttemptEnded('a1');
    expect(trunkChannels.activeChannels('trunkA')).toBe(1);
    trunkChannels.noteAttemptEnded('a2');

    expect(state.snapshot().trunkChannels).toEqual({});
    expect(trunkChannels.activeChannels('trunkA')).toBe(0);
  });
});
