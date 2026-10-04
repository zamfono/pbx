/* eslint-disable no-template-curly-in-string -- a literal ${…} is what these tests send and expect back */
import { describe, expect, it } from 'vitest';

import { type Db } from '@zamfono/shared';

import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb, seedSettings } from '#testing/testDb.js';

import { runOperation } from './runner.js';

import './dids/index.js';
import './trunks/index.js';
import './users/index.js';

type Header = { name: string; value: string };
type DidOut = { id: string; target: unknown; warnings?: string[] };

async function createDid(
  db: Db,
  trunkId: string,
  headers?: Header[]
): Promise<DidOut> {
  const target = {
    kind: 'sip',
    trunkId,
    user: 'proj_abc123',
    ...(headers === undefined ? {} : { headers })
  };
  return runOperation(
    db,
    'dids.create',
    { number: `+43${String(Math.floor(Math.random() * 1e8))}`, target },
    asRun()
  ) as Promise<DidOut>;
}

async function storedHeaders(db: Db, didId: string): Promise<unknown> {
  const row = await db
    .selectFrom('dids')
    .innerJoin('forwardTargets', 'forwardTargets.id', 'dids.targetId')
    .select('forwardTargets.sipHeadersJson')
    .where('dids.id', '=', didId)
    .executeTakeFirstOrThrow();
  return row.sipHeadersJson === null ? null : JSON.parse(row.sipHeadersJson);
}

/** A header whose value renders to `callerName`'s 64 bytes, `copies` times. */
function nameHeader(name: string, copies: number): Header {
  return { name, value: '{{callerName}}'.repeat(copies) };
}

// §9.4 "Header templates", §10.3 "Forward targets": a sip target's configurable headers.
describe('sip target headers', () => {
  it('stores the headers given, none for an empty list, and returns them on reads', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const trunkId = (
      await createTrunk(db, {
        name: 'OpenAI',
        transport: 'tls',
        hosts: [{ host: 'openai.example' }]
      })
    ).trunk.id;
    const headers = [
      { name: 'X-Called', value: '{{calledExtension}}' },
      { name: 'x-reason', value: 'via {{ forwardReason }} ${EXTEN}' }
    ];
    const did = await createDid(db, trunkId, headers);
    expect(did.target).toMatchObject({ headers });
    expect(did.warnings).toBeUndefined();
    expect(await storedHeaders(db, did.id)).toEqual(headers);

    const none = await createDid(db, trunkId, []);
    expect(none.target).toMatchObject({ headers: [] });
    expect(await storedHeaders(db, none.id)).toEqual([]);
  });

  it('refuses bad names, duplicates, bad values and oversized headers with 422', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const trunkId = (
      await createTrunk(db, {
        name: 'OpenAI',
        transport: 'tls',
        hosts: [{ host: 'openai.example' }]
      })
    ).trunk.id;
    const refused: Header[][] = [
      [{ name: 'Diversion', value: 'a' }],
      [{ name: 'X-', value: 'a' }],
      [{ name: 'X_Called', value: 'a' }],
      [{ name: `X-${'a'.repeat(65)}`, value: 'a' }],
      [
        { name: 'X-Called', value: 'a' },
        { name: 'x-CALLED', value: 'b' }
      ],
      [{ name: 'X-Called', value: '{{calledNumber}}' }],
      [{ name: 'X-Called', value: '{{calledExtension}' }],
      [{ name: 'X-Called', value: '{{#if did}}{{did}}{{/if}}' }],
      [{ name: 'X-Called', value: 'a\r\nVia: evil' }],
      // Eight values at the 256-byte cap: 8 × (8 + 2 + 256) = 2128 bytes.
      Array.from({ length: 8 }, (_unused, index) =>
        nameHeader(`X-Name-${String(index)}`, 5)
      )
    ];
    for (const headers of refused) {
      // eslint-disable-next-line no-await-in-loop -- each list is refused on its own
      await expect(createDid(db, trunkId, headers)).rejects.toMatchObject({
        status: 422
      });
    }
  });

  it('limits the size, not the count', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const trunkId = (
      await createTrunk(db, {
        name: 'OpenAI',
        transport: 'tls',
        hosts: [{ host: 'openai.example' }]
      })
    ).trunk.id;
    // 7 × 266 = 1862 bytes, under 2048.
    await createDid(
      db,
      trunkId,
      Array.from({ length: 7 }, (_unused, index) =>
        nameHeader(`X-Name-${String(index)}`, 5)
      )
    );
    // A hundred small headers: 100 × (5 + 2 + 1) = 800 bytes.
    const many = Array.from({ length: 100 }, (_unused, index) => ({
      name: `X-${String(index).padStart(3, '0')}`,
      value: 'a'
    }));
    const did = await createDid(db, trunkId, many);
    expect(await storedHeaders(db, did.id)).toEqual(many);
  });

  it('warns for headers too large for an INVITE over a UDP trunk, and writes them', async () => {
    const db = await makeTestDb();
    await seedSettings(db);
    const udpId = (
      await createTrunk(db, {
        name: 'Carrier',
        transport: 'udp',
        hosts: [{ host: 'carrier.example' }]
      })
    ).trunk.id;
    const tlsId = (
      await createTrunk(db, {
        name: 'OpenAI',
        transport: 'tls',
        hosts: [{ host: 'openai.example' }]
      })
    ).trunk.id;
    const large = [nameHeader('X-Caller-Name', 3)];
    const warned = await createDid(db, udpId, large);
    expect(warned.warnings).toEqual([
      "sip target headers may push an INVITE over UDP trunk 'Carrier' past 1300 bytes"
    ]);
    expect(await storedHeaders(db, warned.id)).toEqual(large);
    // The defaults fit (81 bytes), and TLS carries any size.
    expect((await createDid(db, udpId)).warnings).toBeUndefined();
    expect((await createDid(db, tlsId, large)).warnings).toBeUndefined();

    // The shared target writer warns on every operation that writes through it.
    const forwarding = (await runOperation(
      db,
      'users.setForwarding',
      {
        id: 'owner',
        rules: [
          {
            condition: 'busy',
            target: {
              kind: 'sip',
              trunkId: udpId,
              user: 'agent',
              headers: large
            }
          }
        ]
      },
      asRun()
    )) as { warnings?: string[] };
    expect(forwarding.warnings).toHaveLength(1);
  });
});
