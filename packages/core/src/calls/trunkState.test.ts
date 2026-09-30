import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  newId,
  nowIso,
  openDb,
  registrationUris,
  trunkSectionName,
  type Db,
  type Envelope
} from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { FakeAmi } from '../ami/fake.js';
import { AriClient } from '../ari/client.js';
import { FakeAri } from '../ari/fake.js';
import type { FakeEndpoint } from '../ari/fakeChannel.js';
import type { Logger } from '../ari/types.js';
import { eventually } from '../testing/eventually.js';
import { ConfigCache, EventBus, StateStore } from './pipeline.js';
import { TrunkState } from './trunkState.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

// How long an event that must change nothing is given to not change it.
const SETTLE_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** `ConfigCache` always loads `settings` too (§3.1), so every test needs a minimal row. */
async function seedSettings(db: Db): Promise<void> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({
      id: targetId,
      userId: null,
      ringGroupId: null,
      external: '+15550000',
      mailboxUserId: null,
      mailboxRingGroupId: null,
      announcementAudioId: null,
      menuId: null
    })
    .execute();
  const mainDidId = newId();
  await db
    .insertInto('dids')
    .values({
      id: mainDidId,
      number: '+491110000',
      label: null,
      targetId,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Zamfono',
      mainDidId,
      country: 'DE',
      emergencyNumbersJson: '["112"]'
    })
    .execute();
}

async function seedRegistrationTrunk(
  db: Db,
  username: string,
  host: string
): Promise<string> {
  const id = newId();
  await db
    .insertInto('trunks')
    .values({
      id,
      name: username,
      priority: 1,
      emergency: 1,
      authMode: 'registration',
      username,
      passwordEnc: Buffer.from('secret'),
      inboundAuth: 0,
      transport: 'udp',
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({ trunkId: id, priority: 1, host, port: null, direction: 'both' })
    .execute();
  return id;
}

/** An `ip` trunk, whose status is its first host's `qualify` reachability (§9.4). */
async function seedIpTrunk(
  db: Db,
  name: string,
  priority: number,
  deletedAt: string | null = null
): Promise<string> {
  const id = newId();
  await db
    .insertInto('trunks')
    .values({
      id,
      name,
      priority,
      emergency: 1,
      authMode: 'ip',
      username: null,
      passwordEnc: null,
      inboundAuth: 0,
      transport: 'udp',
      createdAt: nowIso(),
      deletedAt
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId: id,
      priority: 1,
      host: `${name}.example.com`,
      port: null,
      direction: 'both'
    })
    .execute();
  return id;
}

describe('TrunkState', () => {
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let db: Db;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAri: FakeAri;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ari: AriClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let fakeAmi: FakeAmi;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let ami: AmiClient;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let state: StateStore;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let bus: EventBus;
  // eslint-disable-next-line init-declarations -- assigned in beforeEach before each test runs
  let trunkState: TrunkState;

  beforeEach(async () => {
    db = openDb(':memory:');
    await migrateForTest(db);
    fakeAri = new FakeAri();
    const { url } = await fakeAri.listen();
    ari = new AriClient({
      url,
      user: 'zamfono',
      password: 'secret',
      app: 'zamfono',
      log: noopLogger
    });
    await ari.connect();
    fakeAmi = new FakeAmi();
    const address = await fakeAmi.listen();
    ami = new AmiClient({
      host: address.host,
      port: address.port,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
    await ami.connect();
    state = new StateStore();
    bus = new EventBus();
    trunkState = new TrunkState({
      ari,
      ami,
      cache: new ConfigCache(db),
      state,
      bus,
      now: nowIso
    });
  });

  /**
   * Asterisk's `ContactStatusChange` for the contact of AOR `aor` (§9.4, via PJSIP `qualify`).
   * `TrunkState` handles it off the WebSocket, so a test waits for the status it expects; one
   * that expects nothing to change gives the event `SETTLE_MS` to not change it.
   */
  function contactStatus(aor: string, status: string): void {
    fakeAri.emit({
      type: 'ContactStatusChange',
      timestamp: nowIso(),
      application: 'zamfono',
      // eslint-disable-next-line camelcase -- ARI's own event field names
      contact_info: { aor, contact_status: status }
    });
  }

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await ami.close();
    await fakeAmi.close();
    await db.destroy();
  });

  it('reads a registration trunk as registered at boot, then follows Registry events', async () => {
    await seedSettings(db);
    const trunkId = await seedRegistrationTrunk(db, 'acct1', 'sip.example.com');
    const { clientUri, serverUri } = registrationUris({
      username: 'acct1',
      hosts: [{ priority: 1, host: 'sip.example.com', port: null }]
    });
    fakeAmi.registrations.push({
      ObjectName: trunkId,
      ClientUri: clientUri,
      ServerUri: serverUri,
      Status: 'Registered'
    });

    await trunkState.resyncRegistrations();

    expect(state.trunks.get(trunkId)?.status).toBe('registered');

    const emitted: Envelope[] = [];
    const unsubscribe = bus.subscribe(envelope => {
      emitted.push(envelope);
    });

    fakeAmi.emit({
      Event: 'Registry',
      Username: clientUri,
      Domain: serverUri,
      Status: 'Rejected'
    });
    await eventually(() => {
      expect(state.trunks.get(trunkId)?.status).toBe('unreachable');
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'trunk.status',
      trunkId,
      status: 'unreachable'
    });

    fakeAmi.emit({
      Event: 'Registry',
      Username: 'sip:someone-else@unknown.example.com',
      Domain: 'sip:unknown.example.com',
      Status: 'Rejected'
    });
    await sleep(SETTLE_MS);

    expect(state.trunks.get(trunkId)?.status).toBe('unreachable');
    expect(emitted).toHaveLength(1);
    unsubscribe();
  });

  it("follows an ip trunk's qualify reachability from ContactStatusChange, once per change", async () => {
    await seedSettings(db);
    const trunkId = await seedIpTrunk(db, 'carrier', 1);
    const emitted: Envelope[] = [];
    const unsubscribe = bus.subscribe(envelope => {
      emitted.push(envelope);
    });

    contactStatus(trunkSectionName(trunkId), 'Reachable');

    await eventually(() => {
      expect(state.trunks.get(trunkId)?.status).toBe('registered');
    });
    expect(state.trunks.get(trunkId)?.statusChangedAt).toBeTruthy();

    // The next qualify of an unchanged contact is no transition: no second event. The events are
    // handled in the order they arrive, so the second one's been judged once the third's landed.
    contactStatus(trunkSectionName(trunkId), 'Reachable');
    contactStatus(trunkSectionName(trunkId), 'Unreachable');

    await eventually(() => {
      expect(state.trunks.get(trunkId)?.status).toBe('unreachable');
    });
    expect(emitted.map(envelope => envelope.type)).toEqual([
      'trunk.status',
      'trunk.status'
    ]);
    expect(emitted[1]).toMatchObject({
      type: 'trunk.status',
      trunkId,
      status: 'unreachable'
    });
    unsubscribe();
  });

  it('reads each ip trunk\'s reachability from the ARI endpoint list at boot (§9.4 "resyncs at boot")', async () => {
    await seedSettings(db);
    const upId = await seedIpTrunk(db, 'up', 2);
    const downId = await seedIpTrunk(db, 'down', 3);
    const unqualifiedId = await seedIpTrunk(db, 'unqualified', 4);
    const registrationId = await seedRegistrationTrunk(
      db,
      'acct1',
      'sip.example.com'
    );
    const endpoint = (resource: string, reported: string): FakeEndpoint => ({
      technology: 'PJSIP',
      resource,
      state: reported as FakeEndpoint['state'],
      // eslint-disable-next-line camelcase -- ARI's own field name
      channel_ids: []
    });
    // Asterisk qualified these contacts before this process started, so no event is coming.
    fakeAri.endpoints.push(
      endpoint(trunkSectionName(upId), 'online'),
      endpoint(trunkSectionName(downId), 'offline'),
      endpoint(trunkSectionName(unqualifiedId), 'unknown'),
      // A registration trunk's status is its registration outcome, never its endpoint's (§9.4).
      endpoint(trunkSectionName(registrationId), 'offline')
    );

    await trunkState.resyncContacts();

    expect(state.trunks.get(upId)?.status).toBe('registered');
    expect(state.trunks.get(downId)?.status).toBe('unreachable');
    expect(state.trunks.has(unqualifiedId)).toBe(false);
    expect(state.trunks.has(registrationId)).toBe(false);
  });

  it('leaves the status alone for a contact state that says nothing about reachability', async () => {
    await seedSettings(db);
    const trunkId = await seedIpTrunk(db, 'carrier', 1);
    contactStatus(trunkSectionName(trunkId), 'Reachable');
    await eventually(() => {
      expect(state.trunks.get(trunkId)?.status).toBe('registered');
    });

    contactStatus(trunkSectionName(trunkId), 'Created');
    contactStatus(trunkSectionName(trunkId), 'Removed');
    await sleep(SETTLE_MS);

    expect(state.trunks.get(trunkId)?.status).toBe('registered');
  });

  it('ignores ContactStatusChange for a registration trunk, a deleted ip trunk and a device', async () => {
    await seedSettings(db);
    const registrationId = await seedRegistrationTrunk(
      db,
      'acct1',
      'sip.example.com'
    );
    const deletedId = await seedIpTrunk(db, 'gone', 2, nowIso());
    const emitted: Envelope[] = [];
    const unsubscribe = bus.subscribe(envelope => {
      emitted.push(envelope);
    });

    // A registration trunk's status is its registration outcome, which only AMI carries (§9.4).
    contactStatus(trunkSectionName(registrationId), 'Unreachable');
    contactStatus(trunkSectionName(deletedId), 'Reachable');
    // A device's own AOR is its SIP username, never a trunk section (§9.3).
    contactStatus('e101-d1', 'Reachable');
    await sleep(SETTLE_MS);

    expect(state.trunks.size).toBe(0);
    expect(emitted).toHaveLength(0);
    unsubscribe();
  });

  it("serves each trunk's channels in use in the live state until it carries none (§7, §9.4)", async () => {
    trunkState.noteAttemptStarted('trunkA');
    trunkState.noteAttemptStarted('trunkA');
    trunkState.noteAttemptStarted('trunkB');
    trunkState.noteAttemptEnded('trunkB');

    expect((await state.snapshot()).trunkChannels).toEqual({ trunkA: 2 });
    expect(trunkState.activeChannels('trunkA')).toBe(2);

    trunkState.noteAttemptEnded('trunkA');
    trunkState.noteAttemptEnded('trunkA');
    trunkState.noteAttemptEnded('trunkA');

    expect((await state.snapshot()).trunkChannels).toEqual({});
    expect(trunkState.activeChannels('trunkA')).toBe(0);
  });
});
