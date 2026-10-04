import { afterEach, describe, expect, it } from 'vitest';

import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  HTTP_OK,
  newId,
  nowIso,
  type Db
} from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { type FakeAri } from '../testing/ari/fake.js';
import { isPlacement, placedCallerId } from '../testing/ari/fakeDial.js';
import { eventually } from '../testing/eventually.js';
import {
  answeredCall,
  legOf,
  startRig,
  type Rig
} from '../testing/pipelineRig.js';
import {
  seedExternalRoute,
  seedRegisteredDevice,
  seedSlot
} from '../testing/seedRows.js';
import { CallActions } from './actions.js';
import { newCall, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';

// The live-call actions `api`'s parking, voicemail-deposit and per-call CLIR operations proxy to
// (§10.2 "Call parking", §9.3 `*97<ext>`, §9.4 "Anonymous calls (CLIR)"), each through the code
// path the phone's own feature code takes.

function traceOf(call: Call): Record<string, unknown>[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('CallActions: parking, voicemail deposit and per-call CLIR', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let actions: CallActions;

  async function setUp(): Promise<void> {
    rig = await startRig({ apiClient: { mail: () => Promise.resolve() } });
    ({ db, fakeAri, pipeline } = rig);
    // A deposit waits for Asterisk to end its recording (§10.2 "Voicemail").
    fakeAri.recordingFinishedAfterMs = 5;
    actions = new CallActions(pipeline);
  }

  afterEach(async () => {
    await rig.stop();
  });

  it('parks the other party as *70 does, returning the slot, and lists it for everyone', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, { ext: '101' });
    const call = await answeredCall(rig, anna);
    const actorUserId = newId();

    const result = await actions.park(call.id, { userId: anna, actorUserId });

    expect(result).toEqual({ slot: '701' });
    // The parker's own channel leaves the call, as after `*70` (§10.2 "Call parking").
    expect(rig.hungUp(legOf(call))).toBe(true);
    const holds = fakeAri.calls.filter(
      entry => entry.method === 'POST' && entry.path === 'bridges'
    );
    expect(holds.at(-1)?.body).toMatchObject({ type: 'holding' });
    const { parked } = await actions.parked();
    expect(parked).toEqual([
      {
        slot: '701',
        callId: call.id,
        caller: '+15559999',
        parkedAt: expect.any(String) as string,
        parkedByUserId: anna
      }
    ]);
    expect(traceOf(call)).toContainEqual(
      expect.objectContaining({
        event: 'parked',
        by: anna,
        ext: '701',
        actorUserId
      })
    );
  });

  it('lists a parked caller who withheld their number without one (§9.4)', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, { ext: '101' });
    const call = await answeredCall(rig, anna, { from: 'anonymous' });

    await actions.park(call.id, { userId: anna, actorUserId: anna });

    const { parked } = await actions.parked();
    expect(parked.map(entry => entry.caller)).toEqual([null]);
  });

  it('refuses a park by a user not in the call, of an unbridged call, or with every slot taken', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, { ext: '101' });
    const ben = await seedUser(db, { ext: '102' });
    const first = await answeredCall(rig, anna);
    await expect(
      actions.park(first.id, { userId: ben, actorUserId: ben })
    ).rejects.toMatchObject({ status: 409, reason: 'notInCall' });

    const lone = newCall({
      id: newId(),
      direction: 'internal',
      callerChannelId: fakeAri.addChannel({}).id,
      from: '102',
      to: '103',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    lone.callerUserId = ben;
    pipeline.registerCall(lone);
    await expect(
      actions.park(lone.id, { userId: ben, actorUserId: ben })
    ).rejects.toMatchObject({ status: 409, reason: 'notBridged' });

    // A party added to a call (§10.2 "Three-way calls") shares that call's bridge, which is not
    // its own to park from, as it is not its own to transfer, consult on or hold.
    const added = await answeredCall(rig, anna);
    added.addedLeg = true;
    await expect(
      actions.park(added.id, { userId: anna, actorUserId: anna })
    ).rejects.toMatchObject({ status: 409, reason: 'notBridged' });
    expect((await actions.parked()).parked).toEqual([]);

    await actions.park(first.id, { userId: anna, actorUserId: anna });
    const second = await answeredCall(rig, ben);
    await expect(
      actions.park(second.id, { userId: ben, actorUserId: ben })
    ).rejects.toMatchObject({ status: 409, reason: 'noFreeSlot' });
    // Refused, the call stays where it was.
    expect(rig.hungUp(legOf(second))).toBe(false);
    await expect(
      actions.park(newId(), { userId: ben, actorUserId: ben })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a click-to-dial to the slot retrieves the parked call, as dialling it from the phone does', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, { ext: '101' });
    const ben = await seedUser(db, { ext: '102' });
    await seedRegisteredDevice(rig, ben, 'e102-a');
    await rig.devicesUp();
    const call = await answeredCall(rig, anna);
    await actions.park(call.id, { userId: anna, actorUserId: anna });

    const outcome = await actions.originate({
      userId: ben,
      target: '701',
      actorUserId: ben,
      requestId: 'req-1'
    });

    expect(outcome).toHaveProperty('callId');
    await eventually(async () => {
      expect(call.answeredByUserId).toBe(ben);
      const benLeg = [...call.legs.values()].find(leg => leg.userId === ben);
      expect(benLeg?.state).toBe('up');
      expect((await actions.parked()).parked).toEqual([]);
    });
  });

  it('transfers to voicemail, depositing in that mailbox without ringing it, as *97<ext> does', async () => {
    await setUp();
    const anna = await seedUser(db, { ext: '101' });
    const ben = await seedUser(db, { ext: '102' });
    await seedRegisteredDevice(rig, ben, 'e102-a');
    await rig.devicesUp();
    const call = await answeredCall(rig, anna);

    await actions.transfer(call.id, {
      target: '102',
      actorUserId: anna,
      voicemail: true
    });

    await eventually(async () => {
      const child = await db
        .selectFrom('calls')
        .select(['status', 'log', 'direction'])
        .where('parentCallId', '=', call.id)
        .executeTakeFirstOrThrow();
      expect(child.status).toBe('voicemail');
      expect(child.direction).toBe('inbound');
      expect(child.log).toContain('"event":"entry","mailbox":"102"');
      const messages = await db
        .selectFrom('voicemails')
        .select('mailboxUserId')
        .execute();
      expect(messages).toEqual([{ mailboxUserId: ben }]);
    });
    // Nobody's phone rang: no device of 102's was placed.
    expect(
      fakeAri.calls.some(
        entry =>
          isPlacement(entry) &&
          (entry.body as { endpoint?: string }).endpoint === 'PJSIP/e102-a'
      )
    ).toBe(false);
  });

  it('refuses a voicemail transfer to an extension with no mailbox with 422, leaving the call as it was', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, { ext: '101' });
    const call = await answeredCall(rig, anna);

    for (const target of ['999', '701']) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked in turn
      await expect(
        actions.transfer(call.id, {
          target,
          actorUserId: anna,
          voicemail: true
        })
      ).rejects.toMatchObject({ status: 422, reason: 'noMailbox' });
    }
    expect(rig.hungUp(legOf(call))).toBe(false);
  });

  it('withholds the number of a click-to-dial with clir, as #31# would, but never an emergency call’s', async () => {
    await setUp();
    pipeline.deps.trunkState = rig.trunkState();
    await seedExternalRoute(db, 'both');
    const anna = await seedUser(db, { ext: '101' });
    await seedRegisteredDevice(rig, anna, 'e101-a');
    await rig.devicesUp();

    type Placed = {
      endpoint?: string;
      callerId?: string;
      variables?: Record<string, string>;
    };
    const placed = (): Placed[] =>
      fakeAri.calls
        .filter(entry => isPlacement(entry))
        .map(entry => ({
          ...(entry.body as {
            endpoint?: string;
            variables?: Record<string, string>;
          }),
          callerId: placedCallerId(entry)
        }));
    const placedTo = (prefix: string): Placed | undefined =>
      placed().find(entry => entry.endpoint?.startsWith(prefix));

    await actions.originate({
      userId: anna,
      target: '0301234567',
      actorUserId: anna,
      requestId: 'req-clir',
      clir: true
    });
    await eventually(() => {
      const trunkLeg = placedTo('PJSIP/+49301234567@trunk-');
      expect(trunkLeg?.callerId).toBe('+15551234');
      expect(trunkLeg?.variables).toMatchObject({
        'CONNECTEDLINE(pres)': 'prohib'
      });
    });

    await actions.originate({
      userId: anna,
      target: '112',
      actorUserId: anna,
      requestId: 'req-emergency',
      clir: true
    });
    await eventually(() => {
      const emergencyLeg = placedTo('PJSIP/112@trunk-');
      expect(emergencyLeg).toBeDefined();
      expect(emergencyLeg?.variables?.['CONNECTEDLINE(pres)']).toBe(undefined);
    });
  });

  it('serves the park route with 200 and the slot, the parking read, and refuses a malformed flag', async () => {
    await setUp();
    await seedSlot(db, '701');
    const anna = await seedUser(db, { ext: '101' });
    const call = await answeredCall(rig, anna);
    const baseUrl = await rig.startServer(actions);
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

    const flagged = await post(`/internal/calls/${call.id}/transfer`, {
      target: '102',
      actorUserId: anna,
      voicemail: 'yes'
    });
    expect(flagged.status).toBe(HTTP_BAD_REQUEST);
    const parkedResponse = await post(`/internal/calls/${call.id}/park`, {
      userId: anna,
      actorUserId: anna
    });
    expect(parkedResponse.status).toBe(HTTP_OK);
    expect(await parkedResponse.json()).toEqual({ slot: '701' });
    const list = await fetch(`${baseUrl}/internal/parking`);
    expect(list.status).toBe(HTTP_OK);
    const body = (await list.json()) as { parked: { callId: string }[] };
    expect(body.parked.map(entry => entry.callId)).toEqual([call.id]);
    const unknown = await post(`/internal/calls/${newId()}/park`, {
      userId: anna,
      actorUserId: anna
    });
    expect(unknown.status).toBe(HTTP_NOT_FOUND);
    expect(await unknown.json()).toMatchObject({ detail: 'notFound' });
  });
});
