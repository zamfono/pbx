import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from 'vitest';

import { newId, nowIso, type Db, type SipBanReport } from '@zamfono/shared';
import { migratedTestDb, seedSettings } from '@zamfono/shared/testDb.js';

import { AmiClient } from '../ami/client.js';
import type { Logger } from '../ari/types.js';
import { ConfigCache } from '../internal/snapshot.js';
import { FakeAmi } from '../testing/ami/fake.js';
import { eventually } from '../testing/eventually.js';
import { noopLogger } from '../testing/pipelineDeps.js';
import { startSipBanCount } from './report.js';

function failure(address: string): Record<string, string> {
  return {
    Event: 'InvalidAccountID',
    Service: 'PJSIP',
    AccountID: 'scanner',
    RemoteAddress: `IPV4/UDP/${address}/5060`
  };
}

describe('startSipBanCount', () => {
  let db: Db;
  let fakeAmi: FakeAmi;
  let ami: AmiClient;
  let reports: SipBanReport[];
  let sipBan: (report: SipBanReport) => Promise<void>;
  let log: Logger & {
    warn: Mock<Logger['warn']>;
    error: Mock<Logger['error']>;
  };
  let cache: ConfigCache;
  let stop: () => void;

  beforeEach(async () => {
    db = await migratedTestDb();
    await seedSettings(db, { sipBanFailures: 2 });
    fakeAmi = new FakeAmi();
    const address = await fakeAmi.listen();
    ami = new AmiClient({
      ...address,
      username: 'zamfono',
      password: 'secret',
      log: noopLogger
    });
    await ami.connect();
    reports = [];
    sipBan = report => {
      reports.push(report);
      return Promise.resolve();
    };
    log = {
      ...noopLogger,
      warn: vi.fn<Logger['warn']>(),
      error: vi.fn<Logger['error']>()
    };
    cache = new ConfigCache(db);
    ({ stop } = startSipBanCount({
      ami,
      cache,
      api: { sipBan: report => sipBan(report) },
      own: { stack: ['127.0.0.0/8'], internal: ['172.18.0.0/16'] },
      log
    }));
  });

  afterEach(async () => {
    stop();
    await ami.close();
    await fakeAmi.close();
    await db.destroy();
  });

  it('reports an address that reached sip_ban_failures to api', async () => {
    fakeAmi.emit(failure('203.0.113.7'));
    fakeAmi.emit(failure('203.0.113.7'));
    await eventually(() => {
      expect(reports).toEqual([{ address: '203.0.113.7', failures: 2 }]);
    });
  });

  it('reports no allowlisted address', async () => {
    await db
      .insertInto('sipAllowlist')
      .values({ id: newId(), address: '203.0.113.0/24', createdAt: nowIso() })
      .execute();
    // The config propagation that follows an allowlist write (§3.1).
    cache.invalidate();
    fakeAmi.emit(failure('203.0.113.7'));
    fakeAmi.emit(failure('203.0.113.7'));
    fakeAmi.emit(failure('198.51.100.1'));
    fakeAmi.emit(failure('198.51.100.1'));
    await eventually(() => {
      expect(reports).toEqual([{ address: '198.51.100.1', failures: 2 }]);
    });
  });

  it("warns once that the runtime hides the source at the internal network's thresholds", async () => {
    for (let round = 0; round < 4; round += 1) {
      fakeAmi.emit(failure('172.18.0.1'));
    }
    fakeAmi.emit(failure('198.51.100.1'));
    fakeAmi.emit(failure('198.51.100.1'));
    await eventually(() => {
      expect(reports).toEqual([{ address: '198.51.100.1', failures: 2 }]);
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({
      address: '172.18.0.1'
    });
  });

  it('logs a report api refuses and reports the next crossing again', async () => {
    sipBan = () =>
      Promise.reject(new Error('POST /internal/sipBan responded 500'));
    fakeAmi.emit(failure('203.0.113.7'));
    fakeAmi.emit(failure('203.0.113.7'));
    await eventually(() => {
      expect(log.error).toHaveBeenCalledTimes(1);
    });
    sipBan = report => {
      reports.push(report);
      return Promise.resolve();
    };
    fakeAmi.emit(failure('203.0.113.7'));
    fakeAmi.emit(failure('203.0.113.7'));
    await eventually(() => {
      expect(reports).toEqual([{ address: '203.0.113.7', failures: 2 }]);
    });
  });
});
