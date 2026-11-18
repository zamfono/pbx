import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  newId,
  nowIso,
  type Db,
  type HttpAnswer,
  type HttpSend
} from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import type { FakeAri } from '../testing/ari/fake.js';
import { startRig, type Rig } from '../testing/pipelineRig.js';
import { seedDecision, seedForwardTarget } from '../testing/seedRows.js';
import { newCall, type Call } from './call.js';
import { enterTarget } from './inbound.js';
import type { Pipeline } from './pipeline.js';

// §10.1 step 7 "HTTP requests": a request sent while the call waits, whose answer routes it.

const { deposit } = vi.hoisted(() => ({
  deposit: vi.fn<(...args: unknown[]) => Promise<void>>()
}));
vi.mock('./voicemail.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./voicemail.js')>()),
  deposit
}));

/** `call`'s trace lines of `event`. */
function traced(call: Call, event: string): Record<string, unknown>[] {
  return (call.log.finish().log ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(line => line.event === event);
}

describe('an HTTP request on the call path', () => {
  let rig: Rig;
  let db: Db;
  let fakeAri: FakeAri;
  let pipeline: Pipeline;
  let sent: HttpSend[];
  let answer: HttpAnswer | Error;
  let vip: string;
  let standard: string;
  let failed: string;

  /** A user with a mailbox and no phone: entering their mailbox target is where a call ends. */
  async function mailboxTarget(): Promise<{
    userId: string;
    targetId: string;
  }> {
    const userId = await seedUser(db, { mailboxEnabled: 1 });
    return {
      userId,
      targetId: await seedForwardTarget(db, { mailboxUserId: userId })
    };
  }

  /** The request `crm`, whose target is `targetId`, with `row` on top. */
  async function seedRequest(
    targetId: string,
    row: Record<string, unknown> = {}
  ): Promise<string> {
    const id = newId();
    await db
      .insertInto('httpRequests')
      .values({
        id,
        name: 'crm',
        method: 'GET',
        url: 'https://crm.example/customers/{{callerNumber}}?token=s3cret',
        targetId,
        errorTargetId: (
          await mailboxTarget().then(target => {
            failed = target.userId;
            return target;
          })
        ).targetId,
        createdAt: nowIso(),
        ...row
      })
      .execute();
    return id;
  }

  function makeCall(): Call {
    return newCall({
      id: newId(),
      direction: 'inbound',
      callerChannelId: fakeAri.addChannel({}).id,
      from: '+43 660 1',
      to: '+4315550100',
      startedAt: nowIso(),
      logLevel: 'events',
      callLogMaxBytes: 1_048_576
    });
  }

  /** A decision sending a caller whose `crm.data.tier` is `vip` to `vip`, else to `standard`. */
  async function tierDecision(): Promise<string> {
    const [toVip, toStandard] = await Promise.all([
      mailboxTarget(),
      mailboxTarget()
    ]);
    vip = toVip.userId;
    standard = toStandard.userId;
    return seedForwardTarget(db, {
      decisionId: await seedDecision(db, {
        cases: [
          {
            when: [
              { type: 'template', template: '{{crm.data.tier}}', equals: 'vip' }
            ],
            targetId: toVip.targetId
          }
        ],
        defaultTargetId: toStandard.targetId
      })
    });
  }

  beforeEach(async () => {
    sent = [];
    answer = { status: 200, body: '{"data":{"tier":"vip"}}' };
    rig = await startRig({
      httpRequests: {
        secrets: () =>
          Promise.resolve({
            secret: 'sign-me',
            headers: [{ name: 'Authorization', value: 'Bearer tok-123' }]
          }),
        send: request => {
          sent.push(request);
          return answer instanceof Error
            ? Promise.reject(answer)
            : Promise.resolve(answer);
        }
      }
    });
    ({ db, fakeAri, pipeline } = rig);
    deposit.mockReset();
    deposit.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rig.stop();
  });

  const depositedFor = () =>
    deposit.mock.calls.map(args => (args[2] as { userId: string }).userId);

  it('keeps the JSON answer under its name, which a decision behind it routes on', async () => {
    const httpRequestId = await seedRequest(await tierDecision());
    const call = makeCall();

    await enterTarget(
      pipeline,
      call,
      { kind: 'httpRequest', httpRequestId },
      null
    );

    expect(sent).toMatchObject([
      {
        method: 'GET',
        url: 'https://crm.example/customers/%2B43%20660%201?token=s3cret',
        timeoutMs: 5000,
        maxResponseBytes: 65_536
      }
    ]);
    expect(call.variables).toEqual({ crm: { data: { tier: 'vip' } } });
    expect(depositedFor()).toEqual([vip]);
    // The caller heard ringing meanwhile and was not answered; no hop was counted.
    expect(
      fakeAri.calls.some(entry =>
        entry.path.endsWith(`${call.callerChannelId ?? ''}/ring`)
      )
    ).toBe(true);
    expect(call.hops).toBe(0);
    // The trace names the request without its query, headers or body.
    const [line] = traced(call, 'httpRequest');
    expect(line).toMatchObject({
      httpRequestId,
      method: 'GET',
      url: 'https://crm.example/customers/%2B43%20660%201',
      status: 200
    });
    expect(line).not.toHaveProperty('error');
    expect(JSON.stringify(line)).not.toContain('s3cret');
  });

  it('routes on another answer the other way', async () => {
    const httpRequestId = await seedRequest(await tierDecision());
    answer = { status: 200, body: '{"data":{"tier":"basic"}}' };
    await enterTarget(
      pipeline,
      makeCall(),
      { kind: 'httpRequest', httpRequestId },
      null
    );
    expect(depositedFor()).toEqual([standard]);
  });

  it.each([
    ['a status that is no 2xx', { status: 404, body: '{}' }, 'HTTP 404', 404],
    ['a body that is no JSON', { status: 200, body: '<html>' }, 'no JSON', 200],
    [
      'a timeout',
      Object.assign(new Error('late'), { name: 'TimeoutError' }),
      'timeout',
      undefined
    ],
    [
      'a refused address',
      Object.assign(new Error('no'), { code: 'ERR_FORBIDDEN_ADDRESS' }),
      'forbidden address',
      undefined
    ],
    [
      'a body over the limit',
      Object.assign(new Error('big'), { code: 'ERR_RESPONSE_TOO_LARGE' }),
      'response too large',
      undefined
    ]
  ])(
    'sends the call to the error target on %s, with no variable set',
    async (_case, outcome, error, status) => {
      const httpRequestId = await seedRequest(await tierDecision());
      answer = outcome;
      const call = makeCall();

      await enterTarget(
        pipeline,
        call,
        { kind: 'httpRequest', httpRequestId },
        null
      );

      expect(sent).toHaveLength(1);
      expect(call.variables).toEqual({});
      expect(depositedFor()).toEqual([failed]);
      expect(traced(call, 'httpRequest')).toMatchObject([
        status === undefined ? { error } : { error, status }
      ]);
    }
  );

  it("sends a signed POST with the block's headers and body, the secrets being api's to give", async () => {
    const httpRequestId = await seedRequest(await tierDecision(), {
      method: 'POST',
      url: 'http://10.0.0.5/lookup',
      headersJson: JSON.stringify([
        { name: 'Authorization', secret: true },
        { name: 'X-Did', value: '{{did}}' }
      ]),
      secretHeadersEnc: Buffer.from('encrypted'),
      secretEnc: Buffer.from('encrypted'),
      body: '{"caller":"{{callerNumber}}"}',
      contentType: 'application/json',
      timeoutS: 2
    });

    await enterTarget(
      pipeline,
      makeCall(),
      { kind: 'httpRequest', httpRequestId },
      null
    );

    expect(sent).toMatchObject([
      {
        method: 'POST',
        url: 'http://10.0.0.5/lookup',
        headers: { Authorization: 'Bearer tok-123', 'X-Did': '+4315550100' },
        body: '{"caller":"+43 660 1"}',
        contentType: 'application/json',
        secret: 'sign-me',
        timeoutMs: 2000
      }
    ]);
  });

  it('ends a call that meets the request again without a hop in between, as a decision met again', async () => {
    const target = await seedForwardTarget(db, {});
    const httpRequestId = await seedRequest(target);
    await db
      .updateTable('forwardTargets')
      .set({ httpRequestId })
      .where('id', '=', target)
      .execute();
    const call = makeCall();

    await enterTarget(
      pipeline,
      call,
      { kind: 'httpRequest', httpRequestId },
      null
    );

    expect(sent).toHaveLength(1);
    expect(traced(call, 'decisionLoop')).toMatchObject([{ httpRequestId }]);
    expect(call.status).toBe('missed');
  });
});
