import { newId, nowIso, type Db, type LiveCall } from '@zamfono/shared';

import { runOperation } from '#lib/server/ops/runner.js';

import { createUser } from './fixtures.js';
import { asConfirmedRun } from './testDb.js';

// The own-scope matrix's fixtures (`lib/server/ops/ownScope.test.ts`): each own-scoped
// operation's input naming a row of the caller's own or of someone else's, and those rows.

export type Who = 'own' | 'other';
export type Rows = Record<
  | 'user'
  | 'device'
  | 'plainDevice'
  | 'voicemail'
  | 'ooo'
  | 'pat'
  | 'ended'
  | 'live',
  Record<Who, string>
>;

const TARGET = '103';

/** Each own-scoped operation's input naming the `who` side's resource. */
export const INPUTS: Record<
  string,
  (rows: Rows, who: Who) => Record<string, unknown>
> = {
  'calls.addParty': (rows, who) => ({ id: rows.live[who], target: TARGET }),
  'calls.consult': (rows, who) => ({ id: rows.live[who], target: TARGET }),
  'calls.get': (rows, who) => ({ id: rows.ended[who] }),
  'calls.hangup': (rows, who) => ({ id: rows.live[who] }),
  'calls.hold': (rows, who) => ({ id: rows.live[who] }),
  'calls.list': (rows, who) => ({ userId: rows.user[who] }),
  'calls.originate': (rows, who) => ({
    target: TARGET,
    userId: rows.user[who]
  }),
  'calls.park': (rows, who) => ({ id: rows.live[who] }),
  'calls.resume': (rows, who) => ({ id: rows.live[who] }),
  'calls.transfer': (rows, who) => ({ id: rows.live[who], target: TARGET }),
  'devices.create': (rows, who) => ({
    userId: rows.user[who],
    label: 'x',
    kind: 'manual'
  }),
  'devices.delete': (rows, who) => ({ id: rows.device[who] }),
  'devices.getBlf': (rows, who) => ({ id: rows.device[who] }),
  'devices.list': (rows, who) => ({ userId: rows.user[who] }),
  'devices.setBlf': (rows, who) => ({ id: rows.device[who], keys: [] }),
  'devices.update': (rows, who) => ({ id: rows.device[who], label: 'y' }),
  'hours.delete': (rows, who) => ({
    scope: { kind: 'user', id: rows.user[who] }
  }),
  'hours.get': (rows, who) => ({ scope: { kind: 'user', id: rows.user[who] } }),
  'hours.set': (rows, who) => ({
    scope: { kind: 'user', id: rows.user[who] },
    closedTarget: { kind: 'mailboxUser', userId: rows.user[who] },
    intervals: []
  }),
  'ooo.create': (rows, who) => ({
    scope: { kind: 'user', id: rows.user[who] },
    target: { kind: 'mailboxUser', userId: rows.user[who] }
  }),
  'ooo.delete': (rows, who) => ({ id: rows.ooo[who] }),
  'ooo.list': (rows, who) => ({ scope: { kind: 'user', id: rows.user[who] } }),
  'ooo.update': (rows, who) => ({ id: rows.ooo[who], active: false }),
  'personalAccessTokens.create': (rows, who) => ({
    userId: rows.user[who],
    name: 'n'
  }),
  'personalAccessTokens.list': (rows, who) => ({ userId: rows.user[who] }),
  'personalAccessTokens.revoke': (rows, who) => ({ id: rows.pat[who] }),
  'users.clearVoicemailGreeting': (rows, who) => ({ id: rows.user[who] }),
  'users.get': (rows, who) => ({ id: rows.user[who] }),
  'users.getForwarding': (rows, who) => ({ id: rows.user[who] }),
  'users.setForwarding': (rows, who) => ({ id: rows.user[who], rules: [] }),
  'users.setPresence': (rows, who) => ({ id: rows.user[who], dnd: true }),
  'users.setVoicemailGreeting': (rows, who) => ({
    id: rows.user[who],
    upload: { filename: 'g.wav', mimeType: 'audio/wav', data: Buffer.from('x') }
  }),
  'users.update': (rows, who) => ({ id: rows.user[who], clir: true }),
  'voicemails.audio': (rows, who) => ({ id: rows.voicemail[who] }),
  'voicemails.delete': (rows, who) => ({ id: rows.voicemail[who] }),
  'voicemails.markRead': (rows, who) => ({
    id: rows.voicemail[who],
    read: true
  })
};

export function liveCall(callId: string, userId: string): LiveCall {
  return {
    callId,
    legs: [],
    direction: 'internal',
    from: '101',
    to: '102',
    state: 'up',
    startedAt: nowIso(),
    ringGroupId: null,
    userIds: [userId],
    connectedUserIds: [userId]
  };
}

async function seedDevice(db: Db, userId: string, transport: 'tls' | 'plain') {
  const id = newId();
  await db
    .insertInto('devices')
    .values({
      id,
      userId,
      label: 'desk',
      kind: 'manual',
      transport,
      allowedIpsJson: transport === 'plain' ? '["192.0.2.1"]' : null,
      sipUsername: id,
      sipPasswordEnc: Buffer.from('x'),
      createdAt: nowIso()
    })
    .execute();
  return id;
}

async function seedFor(db: Db, userId: string) {
  const voicemail = newId();
  await db
    .insertInto('voicemails')
    .values({
      id: voicemail,
      mailboxUserId: userId,
      caller: '+491234',
      filename: `${voicemail}.wav`,
      durationS: 1,
      read: 0,
      createdAt: nowIso()
    })
    .execute();
  const ended = newId();
  await db
    .insertInto('calls')
    .values({
      id: ended,
      direction: 'internal',
      fromUri: '101',
      toUri: '102',
      status: 'answered',
      startedAt: nowIso(),
      endedAt: nowIso(),
      callerUserId: userId
    })
    .execute();
  const pat = newId();
  await db
    .insertInto('personalAccessTokens')
    .values({ id: pat, userId, name: pat, tokenHash: pat, createdAt: nowIso() })
    .execute();
  const rule = (await runOperation(
    db,
    'ooo.create',
    {
      scope: { kind: 'user', id: userId },
      target: { kind: 'mailboxUser', userId }
    },
    asConfirmedRun()
  )) as { id: string };
  return {
    device: await seedDevice(db, userId, 'tls'),
    plainDevice: await seedDevice(db, userId, 'plain'),
    voicemail,
    ended,
    pat,
    ooo: rule.id
  };
}

/** Seeds two users, `own` and `other`, each with one row of every kind `INPUTS` names. */
export async function seedRows(db: Db): Promise<Rows> {
  const own = await createUser(db, '101');
  const other = await createUser(db, '102', { email: 'other@x.test' });
  const [mine, theirs] = [await seedFor(db, own), await seedFor(db, other)];
  const pair = <K extends keyof typeof mine>(key: K) => ({
    own: mine[key],
    other: theirs[key]
  });
  return {
    user: { own, other },
    device: pair('device'),
    plainDevice: pair('plainDevice'),
    voicemail: pair('voicemail'),
    ooo: pair('ooo'),
    pat: pair('pat'),
    ended: pair('ended'),
    live: { own: 'live-own', other: 'live-other' }
  };
}
