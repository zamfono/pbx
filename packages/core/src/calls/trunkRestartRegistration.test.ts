import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, trunkSectionName, type Db } from '@zamfono/shared';
import { migratedTestDb, seedSettings } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import { AriClient } from '../ari/client.js';
import { EventBus } from '../internal/eventBus.js';
import { ConfigCache } from '../internal/snapshot.js';
import { StateStore } from '../internal/stateStore.js';
import { FakeAmi } from '../testing/ami/fake.js';
import { FakeAri } from '../testing/ari/fake.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { registerTrunksAfterAsteriskStart } from './trunkRestartRegistration.js';
import { TrunkState } from './trunkState.js';

async function seedTrunk(
  db: Db,
  authMode: 'registration' | 'ip',
  transport: 'udp' | 'tcp' | 'tls',
  priority: number
): Promise<string> {
  const id = newId();
  await db
    .insertInto('trunks')
    .values({
      id,
      name: `${authMode}-${transport}`,
      priority,
      emergency: 1,
      authMode,
      username: authMode === 'registration' ? `acct-${transport}` : null,
      passwordEnc: authMode === 'registration' ? Buffer.from('secret') : null,
      inboundAuth: 0,
      transport,
      createdAt: nowIso()
    })
    .execute();
  await db
    .insertInto('trunkHosts')
    .values({
      trunkId: id,
      priority: 1,
      host: 'sip.example.com',
      port: null,
      direction: 'both'
    })
    .execute();
  return id;
}

describe('registerTrunksAfterAsteriskStart (§9.4 "Provisioning and status", §10.4 "After a restart")', () => {
  let db: Db;
  let fakeAri: FakeAri;
  let fakeAmi: FakeAmi;
  let ari: AriClient;
  let ami: AmiClient;
  let tcpId: string;
  let tlsId: string;

  beforeEach(async () => {
    db = await migratedTestDb();
    await seedSettings(db);
    tcpId = await seedTrunk(db, 'registration', 'tcp', 1);
    tlsId = await seedTrunk(db, 'registration', 'tls', 2);
    await seedTrunk(db, 'registration', 'udp', 3);
    await seedTrunk(db, 'ip', 'tls', 4);
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
    const cache = new ConfigCache(db);
    const trunks = new TrunkState({
      log: noopLogger,
      ari,
      ami,
      cache,
      state: new StateStore(),
      bus: new EventBus(),
      now: nowIso,
      plainTransports: { sipUdpEnabled: true, sipTcpEnabled: true }
    });
    await registerTrunksAfterAsteriskStart({
      ari,
      ami,
      cache,
      trunks,
      log: noopLogger
    });
  });

  afterEach(async () => {
    await ari.close();
    await fakeAri.close();
    await ami.close();
    await fakeAmi.close();
    await db.destroy();
  });

  function registered(): (string | undefined)[] {
    return fakeAmi.actions
      .filter(frame => frame.Action === 'PJSIPRegister')
      .map(frame => frame.Registration)
      .sort();
  }

  const both = (): string[] =>
    [trunkSectionName(tcpId), trunkSectionName(tlsId)].sort();

  it('registers every tcp and tls registration trunk once for the Asterisk start found at boot', () => {
    expect(registered()).toEqual(both());
  });

  // FakeAmi holds no registration, so it refuses every `PJSIPRegister` as Asterisk would: the
  // failure is logged, and nothing retries it for the same start.
  it('registers nothing again on a reconnect to the same Asterisk start', async () => {
    const reconnected = new Promise<void>(resolve => {
      ami.once('connected', () => {
        resolve();
      });
    });
    fakeAmi.disconnectClient();
    fakeAri.disconnectClient();
    await reconnected;
    await eventually(() => {
      expect(ari.connected).toBe(true);
    });
    // The reconnect's own read of the start time, which a further registration would follow.
    await ari.asterisk.startupTime();
    // An AMI round trip, behind any `PJSIPRegister` written before it.
    await ami.action('PJSIPShowRegistrationsOutbound');
    expect(registered()).toEqual(both());
  });

  it('registers them again once for a new Asterisk start', async () => {
    fakeAri.restartAsterisk('2026-09-30T09:00:00.000+0000');
    fakeAmi.disconnectClient();
    await eventually(() => {
      expect(registered()).toEqual([...both(), ...both()].sort());
    });
  });
});
