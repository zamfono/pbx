import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, nowIso, type Db, type MailRequest } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { FakeAri } from '../testing/ari/fake.js';
import { requestTo } from '../testing/eventually.js';
import { stubMailSender } from '../testing/pipelineDeps.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedRingGroup } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import type { Pipeline } from './pipeline.js';
import type { Owner } from './release.js';
import { deposit, type MailSender } from './voicemail.js';

/** A mailbox's message limit (§11.5): a deposit into a full mailbox takes no message. */
describe('deposit into a mailbox with a message limit', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let apiClient: MailSender & { sent: MailRequest[] };
  let pipeline: Pipeline;

  beforeEach(async () => {
    apiClient = stubMailSender();
    rig = await startRig({ apiClient });
    ({ db, fakeAri, pipeline } = rig);
  });

  afterEach(async () => {
    await rig.stop();
  });

  function inboundCall(channelId: string, userId: string | null): Call {
    const call = newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: channelId,
      from: '+15559999',
      to: '+15551000',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
    call.calleeUserId = userId;
    pipeline.registerCall(call);
    return call;
  }

  async function seedMessages(mailbox: Owner, count: number): Promise<void> {
    await db
      .insertInto('voicemails')
      .values(
        Array.from({ length: count }, () => {
          const id = newId();
          return {
            id,
            mailboxUserId: 'userId' in mailbox ? mailbox.userId : null,
            mailboxRingGroupId:
              'ringGroupId' in mailbox ? mailbox.ringGroupId : null,
            caller: '+15550000',
            filename: `${id}.wav`,
            durationS: 3,
            createdAt: nowIso()
          };
        })
      )
      .execute();
  }

  it('plays the mailbox-full prompt to a caller of a full user mailbox, records nothing and ends the call as missed', async () => {
    const userId = await seedUser(db, {
      mailboxMaxMessages: 2,
      notifyMissedCalls: 1
    });
    await seedMessages({ userId }, 2);
    const channel = fakeAri.addChannel({});
    const call = inboundCall(channel.id, userId);

    await deposit(pipeline, call, { userId });

    const play = fakeAri.calls.find(
      entry =>
        entry.method === 'POST' && entry.path === `channels/${channel.id}/play`
    );
    expect(play?.body).toMatchObject({ media: 'sound:vm-mailboxfull' });
    expect(fakeAri.calls.some(entry => entry.path.endsWith('/record'))).toBe(
      false
    );
    expect(
      fakeAri.calls.some(
        entry =>
          entry.method === 'DELETE' &&
          entry.path.startsWith(`channels/${channel.id}`)
      )
    ).toBe(true);
    expect(call.status).toBe('missed');
    expect(apiClient.sent.map(request => request.kind)).toEqual(['missedCall']);
    expect(call.log.finish().log).toContain(
      `"event":"voicemailFailed","mailbox":{"userId":"${userId}"},"reason":"mailboxFull"`
    );
    const rows = await db.selectFrom('voicemails').selectAll().execute();
    expect(rows).toHaveLength(2);
  });

  it("refuses a message to a ring group's full mailbox", async () => {
    const ringGroupId = await seedRingGroup(db, { mailboxMaxMessages: 1 });
    await seedMessages({ ringGroupId }, 1);
    const channel = fakeAri.addChannel({});
    const call = inboundCall(channel.id, null);

    await deposit(pipeline, call, { ringGroupId });

    expect(fakeAri.calls.some(entry => entry.path.endsWith('/record'))).toBe(
      false
    );
    expect(call.status).toBe('missed');
  });

  it.each([
    ['below its limit', 3],
    ['without a limit', null]
  ])('records a message into a mailbox %s', async (_label, limit) => {
    const userId = await seedUser(db, { mailboxMaxMessages: limit });
    await seedMessages({ userId }, 2);
    const channel = fakeAri.addChannel({});
    const call = inboundCall(channel.id, userId);

    const started = deposit(pipeline, call, { userId });
    const record = await requestTo(
      fakeAri,
      'POST',
      `channels/${channel.id}/record`
    );
    fakeAri.emit({
      type: 'RecordingFailed',
      timestamp: nowIso(),
      application: 'zamfono',
      recording: { name: (record.body as { name: string }).name }
    });
    await started;
  });
});
