import { afterEach, describe, expect, it } from 'vitest';

import { newId, nowIso } from '@zamfono/shared';

import { startRig, type Rig } from '../testing/pipelineRig.js';
import { newCall, type Call } from './call.js';
import { transferCall } from './transfers.js';

// §7 level `sip`: a dialog's messages reach every call it is part of, the tail of its end
// included. A transfer ends the transferrer's dialog as it closes the call it leaves.

const CALLER_CALL_ID = 'B8664891C6623947B400F7B65B66573B';
const TARGET_CALL_ID = 'c250dcd8-b7d9-4e7b-b232-2aed97a472f2';

/** The BYE Asterisk sends the hung-up sip target, and the target's 200, as HEP mirrors them. */
const TEARDOWN = [
  {
    direction: 'out' as const,
    payload:
      'BYE sips:OAI@sip.api.openai.com:5061 SIP/2.0\r\n' +
      `Call-ID: ${TARGET_CALL_ID}\r\nCSeq: 2 BYE\r\n\r\n`
  },
  {
    direction: 'in' as const,
    payload: `SIP/2.0 200 OK\r\nCall-ID: ${TARGET_CALL_ID}\r\nCSeq: 2 BYE\r\n\r\n`
  }
];

describe('the SIP log of a transferred call (§7 level sip)', () => {
  let rig: Rig;

  afterEach(async () => {
    await rig.stop();
  });

  /** A trunk caller's call to a user, answered by the sip target they forward to
   * unconditionally, at level `sip`, both dialogs joined. */
  async function forwardedToSipTarget(): Promise<{
    call: Call;
    targetChannelId: string;
  }> {
    const { fakeAri, ari, pipeline, cdr } = rig;
    const caller = fakeAri.addChannel({
      name: 'PJSIP/trunk-1-00000001',
      caller: { number: '+15559999', name: '' }
    });
    const target = fakeAri.addChannel({ name: 'PJSIP/trunk-2-00000002' });
    fakeAri.channelVariables.set(
      `${caller.id}:CHANNEL(pjsip,call-id)`,
      CALLER_CALL_ID
    );
    fakeAri.channelVariables.set(
      `${target.id}:CHANNEL(pjsip,call-id)`,
      TARGET_CALL_ID
    );
    const bridge = await ari.bridges.create({ type: 'mixing' });
    await ari.bridges.addChannel(bridge.id, caller.id);
    await ari.bridges.addChannel(bridge.id, target.id);
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: caller.id,
      from: '+15559999',
      to: '+15551077',
      startedAt: nowIso(),
      logLevel: 'sip',
      callLogMaxBytes: 1_048_576
    });
    call.answeredAt = nowIso();
    call.status = 'answered';
    call.bridgeId = bridge.id;
    call.legs.set(target.id, {
      id: newId(),
      channelId: target.id,
      kind: 'trunk',
      userId: null,
      state: 'up',
      endCause: null
    });
    pipeline.registerCall(call);
    pipeline.callByChannel.set(target.id, call);
    await cdr.open(call);
    await cdr.dialogs.joinLeg(call, target.id);
    return { call, targetChannelId: target.id };
  }

  it("logs the BYE releasing the transferrer's dialog, and its 200, in the call the transfer closes", async () => {
    rig = await startRig();
    const { fakeAri, db, pipeline, cdr } = rig;
    const { call, targetChannelId } = await forwardedToSipTarget();
    // Asterisk sends the BYE as it hangs the channel up, and HEP mirrors it with the answer.
    fakeAri.holdRequest = request => {
      if (
        request.method === 'DELETE' &&
        request.path === `channels/${targetChannelId}`
      ) {
        for (const message of TEARDOWN) {
          cdr.dialogs.sipMessage({
            callId: TARGET_CALL_ID,
            at: nowIso(),
            ...message
          });
        }
      }
      return 0;
    };

    // An admin transfers the caller's leg to an external number.
    await transferCall(pipeline, call, {
      target: '+436509471220',
      actorUserId: newId(),
      legId: call.callerLegId
    });

    const row = await db
      .selectFrom('calls')
      .select('log')
      .where('id', '=', call.id)
      .executeTakeFirstOrThrow();
    expect(row.log).toContain('BYE sips:OAI@sip.api.openai.com:5061');
    expect(row.log).toContain('SIP/2.0 200 OK');
  });
});
