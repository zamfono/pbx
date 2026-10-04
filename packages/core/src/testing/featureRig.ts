// Test-only: the rig and helpers the feature-code suites share (`calls/pickup.test.ts`,
// `addParty.test.ts`, `parking.test.ts`, `dndPresence.test.ts`, `mailboxFeatures.test.ts`).
import { expect } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import { newCall, type Call } from '../calls/call.js';
import type { FakeAri } from './ari/fake.js';
import { defaultChannel } from './ari/fakeChannel.js';
import { eventually } from './eventually.js';
import { registerDevice } from './pipelineDeps.js';
import { startRig, type Rig } from './pipelineRig.js';

/** A rig whose devices never answer by themselves, with `settings.parking_timeout_s` set to
 * `parkingTimeoutS` if given. */
export async function startFeatureRig(parkingTimeoutS?: number): Promise<Rig> {
  const rig = await startRig();
  rig.fakeAri.answerAfterMs = 60_000;
  // A deposit reached from a feature waits for Asterisk to end its recording (§10.2).
  rig.fakeAri.recordingFinishedAfterMs = 5;
  if (parkingTimeoutS !== undefined) {
    await rig.db.updateTable('settings').set({ parkingTimeoutS }).execute();
  }
  return rig;
}

/** `registerDevice`, then the device's user's first status past `offline` in the presence log
 * that the hint refresh writes (§10.2 "Presence and BLF"). */
export async function registerWithPresence(
  rig: Rig,
  sipUsername: string
): Promise<void> {
  const { userId } = await rig.db
    .selectFrom('devices')
    .select('userId')
    .where('sipUsername', '=', sipUsername)
    .executeTakeFirstOrThrow();
  await registerDevice(rig.fakeAri, rig.pipeline, sipUsername);
  await eventually(async () => {
    const rows = await rig.db
      .selectFrom('presenceLog')
      .select('status')
      .where('userId', '=', userId)
      .where('status', '!=', 'offline')
      .execute();
    expect(rows).not.toHaveLength(0);
  });
}

/** The device states PUT for extension `ext`'s presence hint, oldest first. */
export function hintPutsFor(
  fakeAri: FakeAri,
  ext: string
): { deviceState?: string }[] {
  return fakeAri.calls
    .filter(
      entry =>
        entry.method === 'PUT' &&
        entry.path === `deviceStates/Stasis:presence-${ext}`
    )
    .map(entry => entry.body as { deviceState?: string });
}

/** Asterisk reporting `channelId` gone. */
export function channelDestroyed(fakeAri: FakeAri, channelId: string): void {
  fakeAri.emit({
    type: 'ChannelDestroyed',
    timestamp: nowIso(),
    application: 'zamfono',
    channel: defaultChannel({ id: channelId }),
    cause: 16
  });
}

export type RowView = {
  status: string;
  answeredAt: string | null;
  endedAt: string | null;
};

export function callsRow(db: Db, callId: string): Promise<RowView> {
  return db
    .selectFrom('calls')
    .select(['status', 'answeredAt', 'endedAt'])
    .where('id', '=', callId)
    .executeTakeFirstOrThrow();
}

/** The `*5` added party hanging up, which ends their leg's own `calls` row (§10.2). */
export async function addedPartyLeaves(
  rig: Rig,
  addPartyCall: Call
): Promise<void> {
  for (const leg of addPartyCall.legs.values()) {
    if (leg.state === 'up') {
      channelDestroyed(rig.fakeAri, leg.channelId);
    }
  }
  await eventually(async () => {
    expect((await callsRow(rig.db, addPartyCall.id)).endedAt).not.toBeNull();
  });
}

export function traceEvents(call: Call): string[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => (JSON.parse(line) as { event?: string }).event ?? '');
}

/**
 * Waits until the ring-group batch tracks its member's leg: a leg is traced once its originate
 * returned and the race holds it, so a pickup from here on finds the group ringing.
 */
export function memberRinging(call: Call): Promise<void> {
  return eventually(() => {
    expect(traceEvents(call)).toContain('ringGroupMember');
  });
}

export async function seedMember(
  db: Db,
  groupId: string,
  position: number,
  userId: string
): Promise<void> {
  await db
    .insertInto('ringGroupMembers')
    .values({ groupId, position, userId, userGroupId: null })
    .execute();
}

export async function seedVoicemail(
  db: Db,
  mailboxUserId: string,
  filename: string
): Promise<string> {
  const id = newId();
  await db
    .insertInto('voicemails')
    .values({
      id,
      mailboxUserId,
      mailboxRingGroupId: null,
      caller: '+15559999',
      filename,
      durationS: 12,
      createdAt: nowIso(),
      read: 0
    })
    .execute();
  return id;
}

export function newInternalCall(
  channelId: string,
  from: string,
  to: string
): Call {
  return newCall({
    id: newId(),
    direction: 'internal',
    callerChannelId: channelId,
    from,
    to,
    startedAt: nowIso(),
    logLevel: 'events',
    callLogMaxBytes: 1_048_576
  });
}
