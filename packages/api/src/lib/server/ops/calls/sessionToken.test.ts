import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nowIso, type StateResponse } from '@zamfono/shared';

import { authenticateSessionToken } from '#lib/server/auth/sessionTokens.js';
import { getCoreClient } from '#lib/server/coreClient.js';
import { stubCoreClient } from '#testing/coreClientStub.js';
import { makeTestDb } from '#testing/testDb.js';

import { runOperation } from '../runner.js';
import { type Actor } from '../types.js';

import './index.js';
import '../users/index.js';

const TOKEN = 'zcs_abc';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

// A voice bot on call `c1`, as `authenticateSessionToken` makes it.
const bot: Actor = {
  id: 'leg-bot',
  name: 'voice bot',
  role: 'user',
  callSession: { callId: 'c1' }
};

/** `core` holding live calls `c1` and `c2`, and the token for `c1` while `live`; the actions it
 * was asked to run. */
function coreWith(live: { token: boolean }): string[] {
  const actions: string[] = [];
  const state: StateResponse = {
    calls: ['c1', 'c2'].map(callId => ({
      callId,
      legs: [],
      direction: 'inbound',
      from: '+491701234567',
      to: '+4930123456',
      state: 'up',
      startedAt: nowIso(),
      ringGroupId: null,
      userIds: [],
      connectedUserIds: []
    })),
    trunks: {},
    trunkChannels: {},
    presence: {},
    registeredDevices: 0,
    recordingMixFailures: 0,
    asteriskChannels: 0,
    recordingsInProgress: 0
  };
  vi.mocked(getCoreClient).mockReturnValue(
    stubCoreClient({
      state: () => Promise.resolve(state),
      hangup: (callId, req) => {
        actions.push(`hangup ${callId} as ${req.actorUserId}`);
        return Promise.resolve();
      },
      transfer: (callId, req) => {
        actions.push(`transfer ${callId} leg ${String(req.legId)}`);
        return Promise.resolve();
      },
      callSession: hash =>
        Promise.resolve(
          live.token && hash === TOKEN_HASH
            ? { callId: 'c1', legId: 'leg-bot' }
            : null
        )
    })
  );
  return actions;
}

async function run(name: string, input: unknown): Promise<unknown> {
  return runOperation(await makeTestDb(), name, input, {
    actor: bot,
    channel: 'rest',
    requestId: 'req-1'
  });
}

afterEach(() => {
  vi.mocked(getCoreClient).mockReset();
});

// §5.2 "Session tokens": a voice bot acts on its own live call, through the call actions alone.
describe('session tokens', () => {
  it('authenticate as the bot on its call while core holds them, and not once the stream ended', async () => {
    coreWith({ token: true });
    await expect(authenticateSessionToken(TOKEN)).resolves.toEqual({
      actor: bot
    });
    await expect(authenticateSessionToken('zcs_other')).resolves.toBeNull();
    coreWith({ token: false });
    await expect(authenticateSessionToken(TOKEN)).resolves.toBeNull();
  });

  it('hang up and transfer their own call, naming the caller’s leg', async () => {
    const actions = coreWith({ token: true });
    await run('calls.hangup', { id: 'c1' });
    await run('calls.transfer', {
      id: 'c1',
      target: '102',
      legId: 'leg-caller'
    });
    expect(actions).toEqual([
      'hangup c1 as leg-bot',
      'transfer c1 leg leg-caller'
    ]);
    // The bot is nobody's own party, so a transfer names the leg that moves.
    await expect(
      run('calls.transfer', { id: 'c1', target: '102' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuse another call and every other operation', async () => {
    const actions = coreWith({ token: true });
    await expect(run('calls.hangup', { id: 'c2' })).rejects.toMatchObject({
      status: 403
    });
    await expect(run('calls.list', { live: true })).rejects.toMatchObject({
      status: 403
    });
    await expect(run('users.get', { id: 'leg-bot' })).rejects.toMatchObject({
      status: 403
    });
    expect(actions).toEqual([]);
  });
});
