// Test-only: a call brought to a stage at a target other than a phone (`calls/hangupStages.test.ts`):
// a mailbox's greeting or recording, a menu, an external number a user forwards to.
import { newId, nowIso, type Db } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import { callerChannel, type Call } from '../calls/call.js';
import {
  answered,
  callIn,
  callUser,
  legsIn,
  NEVER_MS,
  type Scene
} from './callScene.js';
import type { Reached } from './callStages.js';
import { requestTo } from './eventually.js';
import { seedExternalRoute, seedForwardTarget } from './seedRows.js';

const EXTERNAL_NUMBER = '+15557777';
// A playback that ends before anybody hangs up.
const SHORT_MS = 5;

/** A call to a user with a mailbox and no phone (extension 104), which goes straight to it
 * (`offline`), whose greeting plays for `greetingMs`. */
async function toMailbox(scene: Scene, greetingMs: number): Promise<Call> {
  scene.rig.fakeAri.playbackFinishedAfterMs = greetingMs;
  const userId = await seedUser(scene.rig.db, {
    ext: '104',
    mailboxEnabled: 1
  });
  return callUser(scene, userId);
}

export async function inGreeting(scene: Scene): Promise<Reached> {
  const call = await toMailbox(scene, NEVER_MS);
  const caller = callerChannel(call);
  await requestTo(scene.rig.fakeAri, 'POST', `channels/${caller}/play`);
  return { caller };
}

export async function recording(scene: Scene): Promise<Reached> {
  const { fakeAri } = scene.rig;
  const call = await toMailbox(scene, SHORT_MS);
  const caller = callerChannel(call);
  const record = await requestTo(fakeAri, 'POST', `channels/${caller}/record`);
  const { name } = record.body as { name: string };
  return {
    caller,
    // Asterisk finalises the recording as the caller's channel goes.
    afterHangup: () => {
      fakeAri.emit({
        type: 'RecordingFinished',
        timestamp: nowIso(),
        application: 'zamfono',
        recording: { name, duration: 4 }
      });
      return Promise.resolve();
    }
  };
}

/** A one-attempt menu whose fallback is user `userId`. */
async function seedMenu(db: Db, userId: string): Promise<string> {
  const audioId = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id: audioId,
      label: 'Menu',
      kind: 'announcement',
      filename: 'menu.wav',
      createdAt: nowIso()
    })
    .execute();
  const id = newId();
  await db
    .insertInto('menus')
    .values({
      id,
      name: 'Menu',
      audioId,
      fallbackTargetId: await seedForwardTarget(db, { userId }),
      maxAttempts: 1,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

export async function inMenu(scene: Scene): Promise<Reached> {
  const { db, fakeAri } = scene.rig;
  fakeAri.playbackFinishedAfterMs = NEVER_MS;
  const menuId = await seedMenu(db, scene.users.bob);
  const call = await callIn(scene, await seedForwardTarget(db, { menuId }));
  const caller = callerChannel(call);
  await requestTo(fakeAri, 'POST', `channels/${caller}/play`);
  return { caller };
}

/** A call to `alice`, who forwards every call to `EXTERNAL_NUMBER`. */
async function forwardedOut(scene: Scene): Promise<Call> {
  const { db } = scene.rig;
  await seedExternalRoute(db);
  await db
    .insertInto('userForwardRules')
    .values({
      userId: scene.users.alice,
      condition: 'unconditional',
      targetId: await seedForwardTarget(db, { external: EXTERNAL_NUMBER })
    })
    .execute();
  return callUser(scene, scene.users.alice);
}

export async function forwardRinging(scene: Scene): Promise<Reached> {
  const call = await forwardedOut(scene);
  await legsIn(call, 'ringing');
  return { caller: callerChannel(call) };
}

export async function forwardAnswered(scene: Scene): Promise<Reached> {
  const call = await forwardedOut(scene);
  return { caller: callerChannel(call), callee: await answered(scene, call) };
}
