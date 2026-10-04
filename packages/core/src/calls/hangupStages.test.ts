import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { allQuiet, callRows } from '../testing/callLeftovers.js';
import { startScene, type Scene } from '../testing/callScene.js';
import {
  answerBeingBridged,
  blindTransferring,
  consulting,
  groupStillDialling,
  onHold,
  parked,
  pickedUp,
  pickupBeingBridged,
  ringing,
  ringingGroup,
  stillDialling,
  talking,
  type Reached
} from '../testing/callStages.js';
import {
  forwardAnswered,
  forwardRinging,
  inGreeting,
  inMenu,
  recording
} from '../testing/callTargetStages.js';

// A party hanging up at each stage of a call's life (§10.1, §10.2): whoever hangs up, every
// `calls` row ends with the outcome the call reached, the core leaves no channel, bridge, live
// state or timer behind, every hint drops back, and the mails are those of that outcome (§10.2
// "Mail": one missed-call mail per missed inbound call to a user, a call that leaves a message
// sends only the voicemail mail, and one hung up in the greeting is missed like any other).

type Stage = {
  stage: string;
  reach: (scene: Scene) => Promise<Reached>;
  /** Every `calls` row's status, oldest first. */
  rows: string[];
  mails: string[];
  /** Messages left, each with its MWI update. */
  voicemails?: number;
  /** Whether an answered party is there to hang up instead of the caller. */
  callee?: boolean;
};

const stages: Stage[] = [
  {
    stage: 'ringing one user, the phone still being dialled',
    reach: stillDialling,
    rows: ['missed'],
    mails: ['missedCall']
  },
  {
    stage: 'ringing one user',
    reach: ringing,
    rows: ['missed'],
    mails: ['missedCall']
  },
  {
    stage: 'ringing a ring group batch, the phones still being dialled',
    reach: groupStillDialling,
    rows: ['missed'],
    mails: []
  },
  {
    stage: 'ringing a ring group batch',
    reach: ringingGroup,
    rows: ['missed'],
    mails: []
  },
  {
    stage: 'answered, the answer still being bridged',
    reach: answerBeingBridged,
    rows: ['answered'],
    mails: []
  },
  {
    stage: 'answered',
    reach: talking,
    rows: ['answered'],
    mails: [],
    callee: true
  },
  {
    stage: 'on hold',
    reach: onHold,
    rows: ['answered'],
    mails: [],
    callee: true
  },
  {
    stage: 'in a blind transfer, the target ringing',
    reach: blindTransferring,
    rows: ['answered', 'missed'],
    mails: ['missedCall']
  },
  {
    // The callee is the transferrer; the consultation is a row of its own.
    stage: 'in an attended transfer, consulting',
    reach: consulting,
    rows: ['answered', 'answered'],
    mails: [],
    callee: true
  },
  { stage: 'parked', reach: parked, rows: ['answered'], mails: [] },
  {
    stage: 'picked up, the answer still being bridged',
    reach: pickupBeingBridged,
    rows: ['answered'],
    mails: []
  },
  {
    stage: 'picked up',
    reach: pickedUp,
    rows: ['answered'],
    mails: [],
    callee: true
  },
  {
    stage: 'in the voicemail greeting',
    reach: inGreeting,
    rows: ['missed'],
    mails: ['missedCall']
  },
  {
    stage: 'recording a voicemail',
    reach: recording,
    rows: ['voicemail'],
    mails: ['voicemail'],
    voicemails: 1
  },
  { stage: 'in a menu', reach: inMenu, rows: ['missed'], mails: [] },
  {
    stage: 'forwarded to an external number, ringing',
    reach: forwardRinging,
    rows: ['missed'],
    mails: ['missedCall']
  },
  {
    stage: 'forwarded to an external number, answered',
    reach: forwardAnswered,
    rows: ['answered'],
    mails: [],
    callee: true
  }
];

describe('a party hanging up at each stage of a call', () => {
  let scene: Scene;

  beforeEach(async () => {
    scene = await startScene();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await scene.rig.stop();
  });

  async function hangUpAt(
    { reach, rows, mails, voicemails = 0 }: Stage,
    side: 'caller' | 'callee'
  ): Promise<void> {
    const { rig } = scene;
    const reached = await reach(scene);
    const party = reached[side];
    expect(party).toBeDefined();

    rig.fakeAri.hangUpRemotely(party ?? '');
    await reached.afterHangup?.();
    if (side === 'caller' && reached.talkingOn !== undefined) {
      await rig.pipeline.idle();
      rig.fakeAri.hangUpRemotely(reached.talkingOn);
    }

    await allQuiet(rig, scene.timers);
    expect(await callRows(rig.db)).toEqual(
      rows.map(status => ({ status, ended: true }))
    );
    expect(scene.mails.map(mail => mail.kind).sort()).toEqual(mails);
    const stored = await rig.db.selectFrom('voicemails').select('id').execute();
    expect(stored).toHaveLength(voicemails);
    const mwi = rig.fakeAri.calls.filter(
      entry => entry.method === 'PUT' && entry.path.startsWith('mailboxes/')
    );
    expect(mwi).toHaveLength(voicemails);
  }

  it.each(stages)('the caller hangs up $stage', async stage => {
    await hangUpAt(stage, 'caller');
  });

  it.each(stages.filter(stage => stage.callee === true))(
    'the callee hangs up $stage',
    async stage => {
      await hangUpAt(stage, 'callee');
    }
  );
});
