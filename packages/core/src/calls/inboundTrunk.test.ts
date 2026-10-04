import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import type { AriEvent, AriEventOf } from '../ari/events.js';
import type { Channel } from '../ari/types.js';
import type { FakeAri } from '../testing/ari/fake.js';
import { eventually } from '../testing/eventually.js';
import { noopCdr } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import type { PipelineDeps } from './pipelineDeps.js';

function fakeCdr(): PipelineDeps['cdr'] & { opened: Call[] } {
  const opened: Call[] = [];
  return {
    ...noopCdr(),
    opened,
    open: call => {
      opened.push(call);
      return Promise.resolve();
    },
    finish: () => Promise.resolve()
  };
}

/** A DID whose target is an announcement, so a matched call ends as soon as it has played. */
async function seedAnnouncementDid(db: Db, number: string): Promise<string> {
  const audioId = newId();
  await db
    .insertInto('audioAssets')
    .values({
      id: audioId,
      label: 'Welcome',
      kind: 'announcement',
      filename: `${audioId}.wav`,
      createdAt: nowIso()
    })
    .execute();
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, announcementAudioId: audioId })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number, targetId, createdAt: nowIso() })
    .execute();
  return didId;
}

async function seedTrunk(
  db: Db,
  inboundNumberFormat: 'e164' | 'national',
  inboundAuthUsername: string | null = null
): Promise<string> {
  const id = newId();
  await db
    .insertInto('trunks')
    .values({
      id,
      name: `trunk ${inboundNumberFormat} ${inboundAuthUsername ?? ''}`,
      priority: inboundNumberFormat === 'e164' ? 1 : 2,
      emergency: 1,
      authMode: 'ip',
      inboundAuth: inboundAuthUsername === null ? 0 : 1,
      username: inboundAuthUsername,
      passwordEnc: inboundAuthUsername === null ? null : Buffer.from('sealed'),
      transport: 'udp',
      inboundNumberFormat,
      createdAt: nowIso()
    })
    .execute();
  return id;
}

/** A `from-trunk` StasisStart for a channel chan_pjsip named after the trunk's endpoint. */
function inboundEvent(
  channel: Channel,
  exten: string
): AriEventOf<'StasisStart'> {
  return {
    type: 'StasisStart',
    timestamp: nowIso(),
    application: 'zamfono',
    args: ['inbound', exten],
    channel
  };
}

function traceEvents(call: Call | undefined): Record<string, unknown>[] {
  return (call?.log.finish().log ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('inbound number normalization at the trunk boundary (§9.4)', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let ari: AriClient;
  let cdr: PipelineDeps['cdr'] & { opened: Call[] };
  let pipeline: Pipeline;
  let mainDidId: string;

  beforeEach(async () => {
    cdr = fakeCdr();
    rig = await startRig({ cdr });
    ({ db, fakeAri, ari, pipeline } = rig);
    mainDidId = await seedAnnouncementDid(db, '+4930123456');
    await db.updateTable('settings').set({ mainDidId }).execute();
  });

  afterEach(async () => {
    await rig.stop();
  });

  async function arrive(
    trunkId: string,
    called: string,
    caller: string,
    endpoint = `trunk-${trunkId}`
  ): Promise<Call | undefined> {
    const channel = fakeAri.addChannel({
      name: `PJSIP/${endpoint}-0000002a`,
      caller: { number: caller, name: '' }
    });
    await pipeline.handleStasisStart(inboundEvent(channel, called));
    return cdr.opened.find(call => call.callerChannelId === channel.id);
  }

  it('turns a national trunk’s leading 0 into +<calling code> for both parties', async () => {
    const trunkId = await seedTrunk(db, 'national');

    const call = await arrive(trunkId, '030123456', '08912345');

    expect(call?.to).toBe('+4930123456');
    expect(call?.from).toBe('+498912345');
    // The normalized number matched its DID rather than falling through to the fallback.
    expect(call?.didId).toBe(mainDidId);
  });

  it('reads 00 as the international prefix and keeps + on a national trunk', async () => {
    const trunkId = await seedTrunk(db, 'national');

    const call = await arrive(trunkId, '004930123456', '+43123456');

    expect(call?.to).toBe('+4930123456');
    expect(call?.from).toBe('+43123456');
    expect(call?.didId).toBe(mainDidId);
  });

  it('turns an e164 trunk’s 00 into + and leaves a leading 0 alone', async () => {
    const trunkId = await seedTrunk(db, 'e164');

    const call = await arrive(trunkId, '004930123456', '08912345');

    expect(call?.to).toBe('+4930123456');
    expect(call?.from).toBe('08912345');
    expect(call?.didId).toBe(mainDidId);
  });

  it('does not read an e164 trunk’s national digits as a national number', async () => {
    const trunkId = await seedTrunk(db, 'e164');

    const call = await arrive(trunkId, '030123456', '+498912345');

    expect(call?.to).toBe('030123456');
    expect(call?.didId).toBeNull();
  });

  it('passes a provider’s account string verbatim and matches it against dids.number', async () => {
    const trunkId = await seedTrunk(db, 'national');
    const accountDidId = await seedAnnouncementDid(db, 'acct-4711');

    const call = await arrive(trunkId, 'acct-4711', '');

    expect(call?.to).toBe('acct-4711');
    expect(call?.from).toBe('anonymous');
    expect(call?.didId).toBe(accountDidId);
  });

  it('takes the dialled number from To when the Request-URI names the registration account', async () => {
    // mucpbx on 2026-09-29: `INVITE sip:zamfono-test@…;line=…`, `To: <sip:+498995409700@…>`.
    const trunkId = await seedTrunk(db, 'e164');
    const channel = fakeAri.addChannel({
      name: `PJSIP/trunk-${trunkId}-0000002a`,
      caller: { number: '+49892315194925', name: '' }
    });
    fakeAri.channelVariables.set(
      `${channel.id}:PJSIP_HEADER(read,To)`,
      '<sip:+4930123456@46.224.111.67:5060;user=phone>'
    );

    await pipeline.handleStasisStart(inboundEvent(channel, 'zamfono-test'));
    const call = cdr.opened.find(item => item.callerChannelId === channel.id);

    expect(call?.to).toBe('+4930123456');
    expect(call?.didId).toBe(mainDidId);
  });

  it('normalizes a national number in To with the trunk’s format', async () => {
    const trunkId = await seedTrunk(db, 'national');
    const channel = fakeAri.addChannel({
      name: `PJSIP/trunk-${trunkId}-0000002a`,
      caller: { number: '0301111', name: '' }
    });
    fakeAri.channelVariables.set(
      `${channel.id}:PJSIP_HEADER(read,To)`,
      '"Office" <sip:030123456@provider.example>;tag=x'
    );

    await pipeline.handleStasisStart(inboundEvent(channel, 'acct-4711'));
    const call = cdr.opened.find(item => item.callerChannelId === channel.id);

    expect(call?.to).toBe('+4930123456');
  });

  it('keeps the account name when To names the account too', async () => {
    const trunkId = await seedTrunk(db, 'national');
    const accountDidId = await seedAnnouncementDid(db, 'acct-4711');
    const channel = fakeAri.addChannel({
      name: `PJSIP/trunk-${trunkId}-0000002a`,
      caller: { number: '', name: '' }
    });
    fakeAri.channelVariables.set(
      `${channel.id}:PJSIP_HEADER(read,To)`,
      '<sip:acct-4711@provider.example>'
    );

    await pipeline.handleStasisStart(inboundEvent(channel, 'acct-4711'));
    const call = cdr.opened.find(item => item.callerChannelId === channel.id);

    expect(call?.to).toBe('acct-4711');
    expect(call?.didId).toBe(accountDidId);
  });

  it.each([
    ['RFC 3323 anonymous', 'Anonymous'],
    ['a provider’s word for a withheld number', 'Restricted'],
    ['a provider’s word for an unavailable number', 'unavailable']
  ])(
    'carries a caller whose user part is %s as anonymous (§9.4 "Withheld caller")',
    async (_label, user) => {
      const trunkId = await seedTrunk(db, 'e164');

      const call = await arrive(trunkId, '+4930123456', user);

      expect(call?.from).toBe('anonymous');
    }
  );

  it('carries a caller whose identity RFC 3323 privacy suppresses as anonymous, number or not', async () => {
    const trunkId = await seedTrunk(db, 'e164');
    const channel = fakeAri.addChannel({
      name: `PJSIP/trunk-${trunkId}-0000002b`,
      caller: { number: '+498912345', name: '' }
    });
    fakeAri.channelVariables.set(
      `${channel.id}:PJSIP_HEADER(read,Privacy)`,
      'id'
    );

    await pipeline.handleStasisStart(inboundEvent(channel, '+4930123456'));

    const call = cdr.opened.find(entry => entry.callerChannelId === channel.id);
    expect(call?.from).toBe('anonymous');
  });

  it('keeps a caller whose Privacy suppresses nothing, and a non-numeric user part verbatim', async () => {
    const trunkId = await seedTrunk(db, 'e164');
    const channel = fakeAri.addChannel({
      name: `PJSIP/trunk-${trunkId}-0000002c`,
      caller: { number: '+498912345', name: '' }
    });
    fakeAri.channelVariables.set(
      `${channel.id}:PJSIP_HEADER(read,Privacy)`,
      'none'
    );

    await pipeline.handleStasisStart(inboundEvent(channel, '+4930123456'));
    const verbatim = await arrive(trunkId, '+4930123456', 'alice');

    const call = cdr.opened.find(entry => entry.callerChannelId === channel.id);
    expect(call?.from).toBe('+498912345');
    expect(verbatim?.from).toBe('alice');
  });

  it('reads an inbound-auth trunk from the endpoint its digest username names', async () => {
    // `identify_by = auth_username` delivers the call on the endpoint named by the
    // Authorization username (§9.4 "Inbound identification"), not on `trunk-<id>`.
    await seedTrunk(db, 'e164', 'acct-other');
    const trunkId = await seedTrunk(db, 'national', 'acct-4711');

    const call = await arrive(trunkId, '030123456', '08912345', 'acct-4711');

    expect(call?.to).toBe('+4930123456');
    expect(call?.from).toBe('+498912345');
    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'trunk', trunkId })
    );
  });

  it('records the trunk that identified the call in the routing trace', async () => {
    const trunkId = await seedTrunk(db, 'national');

    const call = await arrive(trunkId, '030123456', '08912345');

    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'trunk', trunkId })
    );
  });

  it('says in the routing trace which number matched no DID before it releases with 404', async () => {
    const trunkId = await seedTrunk(db, 'e164');

    const call = await arrive(trunkId, 'zamfono-test', '+49892315194925');

    expect(traceEvents(call)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'entry',
          result: 'noDid',
          called: 'zamfono-test'
        }),
        expect.objectContaining({ event: 'release', code: 404 })
      ])
    );
  });

  it('names the number block and the called number of a fallback in the routing trace (§11.3)', async () => {
    const trunkId = await seedTrunk(db, 'e164');
    const { targetId } = await db
      .selectFrom('dids')
      .select('targetId')
      .where('id', '=', mainDidId)
      .executeTakeFirstOrThrow();
    const blockId = newId();
    await db
      .insertInto('didBlocks')
      .values({
        id: blockId,
        base: '+493012',
        digits: null,
        fallbackTargetId: targetId,
        createdAt: nowIso()
      })
      .execute();

    const call = await arrive(trunkId, '+4930129999', '+49892315194925');

    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({
        event: 'entry',
        result: 'fallback',
        blockId,
        called: '+4930129999'
      })
    );
  });

  it('records a called number taken from To in the routing trace', async () => {
    const trunkId = await seedTrunk(db, 'e164');
    const channel = fakeAri.addChannel({
      name: `PJSIP/trunk-${trunkId}-0000002a`,
      caller: { number: '+49892315194925', name: '' }
    });
    fakeAri.channelVariables.set(
      `${channel.id}:PJSIP_HEADER(read,To)`,
      '<sip:+4930123456@provider.example;user=phone>'
    );

    await pipeline.handleStasisStart(inboundEvent(channel, 'zamfono-test'));
    const call = cdr.opened.find(item => item.callerChannelId === channel.id);

    expect(traceEvents(call)).toContainEqual(
      expect.objectContaining({ event: 'trunk', trunkId, calledFrom: 'to' })
    );
  });

  // §7: the call's level is the maximum of the tenant default and the overrides of the trunk
  // (among others) that routed it; an expired override no longer counts.
  it('raises the call to the delivering trunk’s unexpired diagnostics override', async () => {
    const trunkId = await seedTrunk(db, 'national');
    await db
      .updateTable('trunks')
      .set({ logLevel: 'qos', logLevelExpiresAt: '2999-01-01T00:00:00.000Z' })
      .where('id', '=', trunkId)
      .execute();

    const call = await arrive(trunkId, '030123456', '08912345');

    expect(call?.log.level).toBe('qos');
  });

  it('ignores the delivering trunk’s expired diagnostics override', async () => {
    const trunkId = await seedTrunk(db, 'national');
    await db
      .updateTable('trunks')
      .set({ logLevel: 'qos', logLevelExpiresAt: '2000-01-01T00:00:00.000Z' })
      .where('id', '=', trunkId)
      .execute();

    const call = await arrive(trunkId, '030123456', '08912345');

    expect(call?.log.level).toBe('events');
  });

  it('counts the call among the delivering trunk’s channels in use until its channel is destroyed', async () => {
    const trunkId = await seedTrunk(db, 'national');
    const { state, trunkState } = pipeline.deps;

    const call = await arrive(trunkId, '030123456', '08912345');

    expect(trunkState.activeChannels(trunkId)).toBe(1);
    expect(state.snapshot().trunkChannels).toEqual({ [trunkId]: 1 });

    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: call?.callerChannelId }
    });
    await eventually(() => {
      expect(trunkState.activeChannels(trunkId)).toBe(0);
      expect(state.snapshot().trunkChannels).toEqual({});
    });
  });

  it('does not count a call whose channel is destroyed during the config read that names its trunk', async () => {
    const trunkId = await seedTrunk(db, 'national');
    const { trunkState } = pipeline.deps;
    // The inbound entry's config read is held until the caller's hangup has been delivered.
    const { cache } = pipeline.deps;
    const readConfig = cache.get.bind(cache);
    let releaseRead = (): void => undefined;
    const readHeld = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    cache.get = async () => {
      await readHeld;
      return readConfig();
    };
    const channel = fakeAri.addChannel({
      name: `PJSIP/trunk-${trunkId}-0000002b`,
      caller: { number: '08912345', name: '' }
    });
    const destroyedSeen = new Promise<void>(resolve => {
      ari.on('event', (event: AriEvent) => {
        if (event.type === 'ChannelDestroyed') {
          resolve();
        }
      });
    });

    const entering = pipeline.handleStasisStart(
      inboundEvent(channel, '030123456')
    );
    fakeAri.emit({
      type: 'ChannelDestroyed',
      timestamp: nowIso(),
      application: 'zamfono',
      channel: { id: channel.id }
    });
    await destroyedSeen;
    releaseRead();
    await entering;

    expect(trunkState.activeChannels(trunkId)).toBe(0);
  });
});
