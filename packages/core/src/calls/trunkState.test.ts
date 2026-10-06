import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HTTP_CONFLICT,
  newId,
  nowIso,
  registrationUris,
  trunkSectionName,
  type Db,
  type Envelope
} from '@zamfono/shared';
import { migratedTestDb, seedSettings } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { FakeAmi } from '../testing/ami/fake.js';
import { FakeAri } from '../testing/ari/fake.js';
import type { FakeEndpoint } from '../testing/ari/fakeChannel.js';
import { onEvents } from '../testing/busEvents.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { TrunkState } from './trunkState.js';

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

/** An `ip` trunk, whose status is its first host's `qualify` reachability (§9.4), or
 * `unmonitored` with `qualify` 0. */
async function seedIpTrunk(
  db: Db,
  name: string,
  priority: number,
  deletedAt: string | null = null,
  qualify = 1
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
      deletedAt,
      qualify
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
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let fakeAmi: FakeAmi;
  let ami: AmiClient;
  let state: StateStore;
  let bus: EventBus;
  let cache: ConfigCache;
  let trunkState: TrunkState;
  // What `TrunkState`'s clock reads.
  let clock: string;

  beforeEach(async () => {
    db = await migratedTestDb();
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
    cache = new ConfigCache(db);
    clock = nowIso();
    trunkState = new TrunkState({
      log: noopLogger,
      ari,
      ami,
      cache,
      state,
      bus,
      now: () => clock,
      plainTransports: { sipUdpEnabled: true, sipTcpEnabled: true }
    });
  });

  /**
   * Asterisk's `ContactStatusChange` for the contact of AOR `aor` (§9.4, via PJSIP `qualify`).
   * `TrunkState` handles it off the WebSocket, so a test waits for the status it expects; one
   * that expects nothing to change sends one that does after it, and waits for that.
   */
  function contactStatus(aor: string, status: string): void {
    fakeAri.emit({
      type: 'ContactStatusChange',
      timestamp: nowIso(),
      application: 'zamfono',
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
    const unsubscribe = onEvents(bus, envelope => {
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
    // Handled in the order they arrive: the stranger's has been judged once this one's landed.
    fakeAmi.emit({
      Event: 'Registry',
      Username: clientUri,
      Domain: serverUri,
      Status: 'Registered'
    });
    await eventually(() => {
      expect(state.trunks.get(trunkId)?.status).toBe('registered');
    });

    expect(emitted).toMatchObject([
      { trunkId, status: 'unreachable' },
      { trunkId, status: 'registered' }
    ]);
    unsubscribe();
  });

  describe('registeredAt (§9.4 "Provisioning and status")', () => {
    let trunkId: string;
    let uris: { clientUri: string; serverUri: string };

    beforeEach(async () => {
      await seedSettings(db);
      trunkId = await seedRegistrationTrunk(db, 'acct1', 'sip.example.com');
      uris = registrationUris({
        username: 'acct1',
        hosts: [{ priority: 1, host: 'sip.example.com', port: null }]
      });
      fakeAmi.registrations.push({
        ObjectName: trunkSectionName(trunkId),
        ClientUri: uris.clientUri,
        ServerUri: uris.serverUri,
        Status: 'Registered'
      });
      clock = '2026-10-05T10:00:00.000Z';
    });

    function registry(status: string): void {
      fakeAmi.emit({
        Event: 'Registry',
        Username: uris.clientUri,
        Domain: uris.serverUri,
        Status: status
      });
    }

    it('moves on every Registered Registry event, a refresh that keeps the status included', async () => {
      const emitted: Envelope[] = [];
      const unsubscribe = onEvents(bus, envelope => {
        emitted.push(envelope);
      });
      registry('Registered');
      await eventually(() => {
        expect(state.trunks.get(trunkId)).toEqual({
          status: 'registered',
          statusChangedAt: '2026-10-05T10:00:00.000Z',
          registeredAt: '2026-10-05T10:00:00.000Z'
        });
      });

      clock = '2026-10-05T10:01:45.000Z';
      registry('Registered');
      await eventually(() => {
        expect(state.trunks.get(trunkId)).toEqual({
          status: 'registered',
          statusChangedAt: '2026-10-05T10:00:00.000Z',
          registeredAt: '2026-10-05T10:01:45.000Z'
        });
      });

      // A failed REGISTER keeps the last one that succeeded.
      clock = '2026-10-05T10:03:30.000Z';
      registry('Rejected');
      await eventually(() => {
        expect(state.trunks.get(trunkId)).toEqual({
          status: 'unreachable',
          statusChangedAt: '2026-10-05T10:03:30.000Z',
          registeredAt: '2026-10-05T10:01:45.000Z'
        });
      });
      expect(emitted).toMatchObject([
        { trunkId, status: 'registered' },
        { trunkId, status: 'unreachable' }
      ]);
      unsubscribe();
    });

    it('is null at the boot resync, which tells no time, and again once the AMI connection reopens', async () => {
      await trunkState.resyncRegistrations();
      expect(state.trunks.get(trunkId)).toMatchObject({
        status: 'registered',
        registeredAt: null
      });
      registry('Registered');
      await eventually(() => {
        expect(state.trunks.get(trunkId)?.registeredAt).toBe(clock);
      });

      const reconnected = new Promise<void>(resolve => {
        ami.once('connected', () => {
          resolve();
        });
      });
      fakeAmi.disconnectClient();
      await reconnected;

      await eventually(() => {
        expect(state.trunks.get(trunkId)).toMatchObject({
          status: 'registered',
          registeredAt: null
        });
      });
    });

    it("reregister has Asterisk register the trunk's registration afresh", async () => {
      await trunkState.reregister(trunkId);

      expect(fakeAmi.actions).toContainEqual(
        expect.objectContaining({
          Action: 'PJSIPRegister',
          Registration: trunkSectionName(trunkId)
        })
      );
    });

    it('reregister refuses a trunk without a registration with 409 noRegistration', async () => {
      const ipTrunkId = await seedIpTrunk(db, 'carrier', 2);

      await expect(trunkState.reregister(ipTrunkId)).rejects.toMatchObject({
        status: HTTP_CONFLICT,
        reason: 'noRegistration'
      });
      await expect(
        trunkState.reregister('no-such-trunk')
      ).rejects.toMatchObject({
        status: HTTP_CONFLICT,
        reason: 'noRegistration'
      });
      expect(
        fakeAmi.actions.filter(frame => frame.Action === 'PJSIPRegister')
      ).toEqual([]);
    });
  });

  it("follows an ip trunk's qualify reachability from ContactStatusChange, once per change", async () => {
    await seedSettings(db);
    const trunkId = await seedIpTrunk(db, 'carrier', 1);
    const emitted: Envelope[] = [];
    const unsubscribe = onEvents(bus, envelope => {
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

    const emitted: Envelope[] = [];
    const unsubscribe = onEvents(bus, envelope => {
      emitted.push(envelope);
    });
    contactStatus(trunkSectionName(trunkId), 'Created');
    contactStatus(trunkSectionName(trunkId), 'Removed');
    // Handled in the order they arrive: the two before have been judged once this one's landed.
    contactStatus(trunkSectionName(trunkId), 'Unreachable');
    await eventually(() => {
      expect(state.trunks.get(trunkId)?.status).toBe('unreachable');
    });

    expect(emitted).toMatchObject([{ trunkId, status: 'unreachable' }]);
    unsubscribe();
  });

  it('ignores ContactStatusChange for a registration trunk, a deleted ip trunk and a device', async () => {
    await seedSettings(db);
    const registrationId = await seedRegistrationTrunk(
      db,
      'acct1',
      'sip.example.com'
    );
    const deletedId = await seedIpTrunk(db, 'gone', 2, nowIso());
    const probedId = await seedIpTrunk(db, 'carrier', 3);
    const emitted: Envelope[] = [];
    const unsubscribe = onEvents(bus, envelope => {
      emitted.push(envelope);
    });

    // A registration trunk's status is its registration outcome, which only AMI carries (§9.4).
    contactStatus(trunkSectionName(registrationId), 'Unreachable');
    contactStatus(trunkSectionName(deletedId), 'Reachable');
    // A device's own AOR is its SIP username, never a trunk section (§9.3).
    contactStatus('e101-d1', 'Reachable');
    // Handled in the order they arrive: the three before have been judged once this one's landed.
    contactStatus(trunkSectionName(probedId), 'Reachable');
    await eventually(() => {
      expect(state.trunks.get(probedId)?.status).toBe('registered');
    });

    expect([...state.trunks.keys()]).toEqual([probedId]);
    expect(emitted).toMatchObject([{ trunkId: probedId }]);
    unsubscribe();
  });

  // §9.4 "Provisioning and status": `trunks.qualify` off renders `qualify_frequency = 0`, so
  // Asterisk probes nothing and the contact reads `NonQualified`; the trunk is `unmonitored`.
  describe('an ip trunk with qualify off', () => {
    async function setQualify(trunkId: string, qualify: number): Promise<void> {
      await db
        .updateTable('trunks')
        .set({ qualify })
        .where('id', '=', trunkId)
        .execute();
      // What `/internal/configChanged` does before it refreshes (§3.1).
      cache.invalidate();
      await trunkState.refreshMonitoring();
    }

    it('is unmonitored at boot whatever its endpoint reports', async () => {
      await seedSettings(db);
      const trunkId = await seedIpTrunk(db, 'agent', 1, null, 0);
      fakeAri.endpoints.push({
        technology: 'PJSIP',
        resource: trunkSectionName(trunkId),
        state: 'offline',
        channel_ids: []
      });

      await trunkState.resyncContacts();

      expect(state.trunks.get(trunkId)?.status).toBe('unmonitored');
    });

    it('stays unmonitored on any ContactStatusChange, with one trunk.status event', async () => {
      await seedSettings(db);
      const trunkId = await seedIpTrunk(db, 'agent', 1, null, 0);
      const probedId = await seedIpTrunk(db, 'carrier', 2);
      const emitted: Envelope[] = [];
      const unsubscribe = onEvents(bus, envelope => {
        emitted.push(envelope);
      });

      contactStatus(trunkSectionName(trunkId), 'NonQualified');
      await eventually(() => {
        expect(state.trunks.get(trunkId)?.status).toBe('unmonitored');
      });
      // A probe result from before the switch, which a reload can still deliver.
      contactStatus(trunkSectionName(trunkId), 'Unreachable');
      // Handled in the order they arrive: the one before has been judged once this one's landed.
      contactStatus(trunkSectionName(probedId), 'Reachable');
      await eventually(() => {
        expect(state.trunks.get(probedId)?.status).toBe('registered');
      });

      expect(state.trunks.get(trunkId)?.status).toBe('unmonitored');
      expect(emitted).toMatchObject([
        { type: 'trunk.status', trunkId, status: 'unmonitored' },
        { type: 'trunk.status', trunkId: probedId, status: 'registered' }
      ]);
      unsubscribe();
    });

    it('turns unmonitored when qualify is switched off, and unknown until its first probe when switched back on', async () => {
      await seedSettings(db);
      const trunkId = await seedIpTrunk(db, 'agent', 1);
      contactStatus(trunkSectionName(trunkId), 'Unreachable');
      await eventually(() => {
        expect(state.trunks.get(trunkId)?.status).toBe('unreachable');
      });

      await setQualify(trunkId, 0);
      expect(state.trunks.get(trunkId)?.status).toBe('unmonitored');

      await setQualify(trunkId, 1);
      expect(state.trunks.get(trunkId)?.status).toBe('unknown');
      contactStatus(trunkSectionName(trunkId), 'Reachable');
      await eventually(() => {
        expect(state.trunks.get(trunkId)?.status).toBe('registered');
      });
    });

    it('leaves a probed trunk and a registration trunk alone on a refresh', async () => {
      await seedSettings(db);
      const probedId = await seedIpTrunk(db, 'carrier', 2);
      const registrationId = await seedRegistrationTrunk(
        db,
        'acct1',
        'sip.example.com'
      );
      contactStatus(trunkSectionName(probedId), 'Reachable');
      await eventually(() => {
        expect(state.trunks.get(probedId)?.status).toBe('registered');
      });

      // `qualify` means nothing to a registration trunk, whose status is its registration's.
      await setQualify(registrationId, 0);

      expect(state.trunks.get(probedId)?.status).toBe('registered');
      expect(state.trunks.has(registrationId)).toBe(false);
    });
  });

  // §9.4 "Signaling": Asterisk binds a transport SIP_UDP_ENABLED or SIP_TCP_ENABLED switches off
  // to loopback (§9.1), so nothing a trunk on it reports means it is reachable.
  it('reads a trunk on a switched-off transport as unreachable, whatever its qualify or registration', async () => {
    await seedSettings(db);
    const unprobedId = await seedIpTrunk(db, 'agent', 3, null, 0);
    const probedId = await seedIpTrunk(db, 'carrier', 2);
    const registrationId = await seedRegistrationTrunk(
      db,
      'acct1',
      'sip.example.com'
    );
    const { clientUri, serverUri } = registrationUris({
      username: 'acct1',
      hosts: [{ priority: 1, host: 'sip.example.com', port: null }]
    });
    fakeAmi.registrations.push({
      ObjectName: registrationId,
      ClientUri: clientUri,
      ServerUri: serverUri,
      Status: 'Registered'
    });
    fakeAri.endpoints.push({
      technology: 'PJSIP',
      resource: trunkSectionName(probedId),
      state: 'online',
      channel_ids: []
    });
    const udpOff = new TrunkState({
      log: noopLogger,
      ari,
      ami,
      cache,
      state,
      bus,
      now: nowIso,
      plainTransports: { sipUdpEnabled: false, sipTcpEnabled: true }
    });

    await udpOff.resyncOnBoot();
    for (const id of [unprobedId, probedId, registrationId]) {
      expect(state.trunks.get(id)?.status).toBe('unreachable');
    }

    // A config change settles an unprobed trunk's status without Asterisk.
    await udpOff.refreshMonitoring();
    expect(state.trunks.get(unprobedId)?.status).toBe('unreachable');
  });
});
