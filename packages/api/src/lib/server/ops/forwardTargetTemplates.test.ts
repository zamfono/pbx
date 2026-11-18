import { describe, expect, it } from 'vitest';

import { seedSettings } from '@zamfono/shared/testDb.js';

import { createTrunk } from '#testing/fixtures.js';
import { asRun, makeTestDb } from '#testing/testDb.js';

import { runOperation } from './runner.js';
import type { Actor } from './types.js';

import './decisions/index.js';
import './dids/index.js';
import './trunks/index.js';
import './users/index.js';

// §9.4 "Templates", §10.3 "Forward targets": the target fields that take a template, the kind
// `extension` and a decision's `template` condition, on write.

const anna: Actor = { id: 'owner', name: 'Owner', role: 'user' };

async function arrange() {
  const db = await makeTestDb();
  await seedSettings(db);
  const setForwarding = (target: Record<string, unknown>, actor?: Actor) =>
    runOperation(
      db,
      'users.setForwarding',
      { id: 'owner', rules: [{ condition: 'unconditional', target }] },
      asRun(actor === undefined ? {} : { actor })
    ) as Promise<{ rules: { target: unknown }[] }>;
  return { db, setForwarding };
}

describe('templated forward targets', () => {
  it('stores a template in a number, a user part, a URL and an extension target, and reads it back', async () => {
    const { db, setForwarding } = await arrange();
    const { trunk } = await createTrunk(db, {
      name: 'Agent',
      hosts: [{ host: 'sip.agent.example', direction: 'outbound' }]
    });
    const chain = {
      kind: 'extension',
      extension: '{{slice did -2}}',
      fallback: {
        kind: 'external',
        external: '+431234{{slice (digits callerNumber) -2}}',
        fallback: {
          kind: 'sip',
          trunkId: trunk.id,
          user: 'q-{{calledExtension}}',
          headers: [{ name: 'X-Branch', value: '{{slice did -2}}' }],
          fallback: {
            kind: 'webSocket',
            protocol: 'twilio',
            url: 'wss://bot.example/media?caller={{callerNumber}}'
          }
        }
      }
    };
    const result = await setForwarding(chain);
    expect(result.rules[0]?.target).toMatchObject(chain);
  });

  it('refuses a template that is none, names an unknown value or holds text its field cannot', async () => {
    const { db, setForwarding } = await arrange();
    const { trunk } = await createTrunk(db, {
      name: 'Agent',
      hosts: [{ host: 'sip.agent.example', direction: 'outbound' }]
    });
    const refused: Record<string, unknown>[] = [
      { kind: 'external', external: '+43{{slice did}}' },
      { kind: 'external', external: '+43{{#if did}}1{{/if}}' },
      { kind: 'external', external: '0043 {{did}}' },
      { kind: 'external', external: '+43{{crm.branch}}' },
      { kind: 'extension', extension: '17' },
      { kind: 'extension', extension: '{{nope}}' },
      { kind: 'sip', trunkId: trunk.id, user: 'a@{{did}}' },
      {
        kind: 'sip',
        trunkId: trunk.id,
        user: 'agent',
        headers: [{ name: 'X-A', value: '{{nope}}' }]
      },
      { kind: 'webSocket', protocol: 'twilio', url: 'wss://{{did}}.example/' },
      {
        kind: 'webSocket',
        protocol: 'twilio',
        url: 'https://bot.example/{{did}}'
      },
      { kind: 'webSocket', protocol: 'twilio', url: 'ws://127.0.0.1/{{did}}' }
    ];
    for (const target of refused) {
      // eslint-disable-next-line no-await-in-loop -- one refusal after the other
      await expect(
        setForwarding(target),
        JSON.stringify(target)
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it('lets only an admin set a template, and shows it to the user as the marker', async () => {
    const { setForwarding } = await arrange();
    await expect(
      setForwarding({ kind: 'external', external: '+43{{digits did}}' }, anna)
    ).rejects.toMatchObject({
      status: 403,
      title: 'a templated target is set by an admin'
    });
    await expect(
      setForwarding({ kind: 'extension', extension: '{{slice did -2}}' }, anna)
    ).rejects.toMatchObject({
      status: 403,
      title: 'an extension target is set by an admin'
    });
    await setForwarding({ kind: 'extension', extension: '{{slice did -2}}' });
    const marker = { managed: true, kind: 'extension' };
    expect((await setForwarding(marker, anna)).rules).toEqual([
      { condition: 'unconditional', target: marker }
    ]);
  });
});

describe("a decision's template condition", () => {
  it('is stored and read back, and refused for a bad template or an unknown value', async () => {
    const { db } = await arrange();
    const create = (when: unknown[]) =>
      runOperation(
        db,
        'decisions.create',
        {
          name: `d${String(Math.random())}`,
          cases: [{ when, target: { kind: 'hangup' } }],
          default: { kind: 'hangup' }
        },
        asRun()
      ) as Promise<{ cases: { when: unknown[] }[] }>;
    const when = [
      {
        type: 'any',
        conditions: [
          { type: 'template', template: '{{slice did -2}}', equals: '17' },
          {
            type: 'template',
            template: '{{length (digits callerNumber)}}',
            equals: '4'
          }
        ]
      }
    ];
    expect((await create(when)).cases[0]?.when).toEqual(when);
    for (const template of [
      '{{slice did}}',
      '{{#if did}}x{{/if}}',
      '{{crm.tier}}'
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal after the other
      await expect(
        create([{ type: 'template', template, equals: 'x' }]),
        template
      ).rejects.toMatchObject({ status: 422 });
    }
  });
});
