import { beforeEach, describe, expect, it } from 'vitest';

import { epochSeconds, type Db } from '@zamfono/shared';
import { seedSettings } from '@zamfono/shared/testDb.js';

import { signAccessToken } from '#lib/server/auth/jwt.js';
import { handleRest } from '#lib/server/rest.js';
import {
  admin,
  createSipTargetTrunk,
  createUserActor
} from '#testing/forwardingTestKit.js';
import {
  CLIENT_ID,
  currentHeaders,
  currentMeta,
  JWT_SECRET,
  mcpRequest,
  ORIGIN,
  rpc
} from '#testing/mcp/testKit.js';
import {
  asConfirmedRun,
  asRun,
  makeTestDb,
  seedSession
} from '#testing/testDb.js';

import { runOperation } from './runner.js';
import type { Actor } from './types.js';

import './index.js';

// §10.3 "Forward targets": a `user` reads an admin-set target of their own forwarding, OOO rule or
// opening hours as `{ managed: true, kind }`, sends it back to keep the target, and never reads or
// writes its URL, token or headers; admins and owners read and write it in full.

const BOT_URL = 'wss://bot.example/media?token=s3cret-bot-token';
const HEADER_VALUE = 'Bearer s3cret-header';

type Fixture = {
  db: Db;
  anna: Actor;
  token: string;
  oooId: string;
  webSocket: Record<string, unknown>;
  sip: Record<string, unknown>;
  recorded: Record<string, unknown>;
};

let fx: Fixture;

/** Anna, a `user`, with an admin-set webSocket `noAnswer` rule, sip `busy` rule and her own
 * `offline` one, an admin-set OOO rule to a recording external number, and admin-set hours closed
 * to the bot; plus an MCP token of hers. */
async function arrange(): Promise<Fixture> {
  const db = await makeTestDb();
  await seedSettings(db);
  const anna = await createUserActor(db, 'Anna Huber', '101');
  const trunkId = await createSipTargetTrunk(db);
  const webSocket = {
    kind: 'webSocket',
    protocol: 'twilio',
    url: BOT_URL,
    sampleRate: 8000,
    record: false,
    fallback: { kind: 'mailboxUser', userId: anna.id }
  };
  const sip = {
    kind: 'sip',
    trunkId,
    user: 'proj_abc123',
    headers: [{ name: 'X-Auth', value: HEADER_VALUE }],
    ringTimeoutS: 20,
    record: false,
    fallback: null
  };
  const recorded = {
    kind: 'external',
    external: '+4319999',
    ringTimeoutS: null,
    record: true,
    fallback: null
  };
  await runOperation(
    db,
    'users.setForwarding',
    {
      id: anna.id,
      rules: [
        { condition: 'busy', target: sip },
        { condition: 'noAnswer', target: webSocket },
        {
          condition: 'offline',
          target: { kind: 'mailboxUser', userId: anna.id }
        }
      ]
    },
    asRun({ actor: admin })
  );
  const { id: oooId } = (await runOperation(
    db,
    'ooo.create',
    { scope: { kind: 'user', id: anna.id }, active: false, target: recorded },
    asRun({ actor: admin })
  )) as { id: string };
  await runOperation(
    db,
    'hours.set',
    {
      scope: { kind: 'user', id: anna.id },
      closedTarget: webSocket,
      intervals: [{ weekday: 1, opens: '08:00', closes: '17:00' }]
    },
    asRun({ actor: admin })
  );
  const sid = 'session-anna';
  await seedSession(db, anna.id, CLIENT_ID, sid);
  const token = await signAccessToken(
    JWT_SECRET,
    { sub: anna.id, role: 'user', cid: CLIENT_ID, sid },
    epochSeconds(Date.now()),
    ORIGIN
  );
  return { db, anna, token, oooId, webSocket, sip, recorded };
}

beforeEach(async () => {
  fx = await arrange();
});

/** A REST call as `actor`, answering status and parsed body. */
async function rest(
  actor: Actor,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleRest(
    new Request(`http://api/api/v1${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
    }),
    actor,
    { db: fx.db, requestId: 'req-1' }
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>
  };
}

/** An MCP tool call as Anna, answering its structured content and whether it is an error. */
async function tool(
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; content: Record<string, unknown> }> {
  const params = { name, arguments: args };
  const body = await rpc(
    { db: fx.db, jwtSecret: JWT_SECRET, origin: ORIGIN },
    mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { ...params, _meta: currentMeta() }
      },
      currentHeaders('tools/call', params),
      fx.token
    )
  );
  const result = body.result as {
    isError: boolean;
    structuredContent: Record<string, unknown>;
  };
  return { isError: result.isError, content: result.structuredContent };
}

/** Every `forward_targets` row as stored, by id, to compare byte for byte. */
async function targetRows(db: Db): Promise<unknown[]> {
  return db.selectFrom('forwardTargets').selectAll().orderBy('id').execute();
}

/** No secret a masked read must leave out appears anywhere in `value`. */
function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of ['s3cret', 'wss://', 'proj_abc123', '+4319999']) {
    expect(text).not.toContain(secret);
  }
}

const scopePath = (): string => `/users/${fx.anna.id}`;
const markedRules = (): unknown[] => [
  { condition: 'busy', target: { managed: true, kind: 'sip' } },
  { condition: 'noAnswer', target: { managed: true, kind: 'webSocket' } },
  { condition: 'offline', target: { kind: 'mailboxUser', userId: fx.anna.id } }
];

describe('a user reads admin-set targets masked', () => {
  it('over REST: forwarding, OOO rules and hours', async () => {
    const forwarding = await rest(fx.anna, 'GET', `${scopePath()}/forwarding`);
    expect(forwarding).toEqual({
      status: 200,
      body: { id: fx.anna.id, rules: markedRules() }
    });
    const ooo = await rest(fx.anna, 'GET', `${scopePath()}/ooo`);
    expect(ooo.body.items).toEqual([
      expect.objectContaining({
        id: fx.oooId,
        target: { managed: true, kind: 'external' }
      })
    ]);
    const hours = await rest(fx.anna, 'GET', `${scopePath()}/hours`);
    expect(hours.body.schedule).toMatchObject({
      closedTarget: { managed: true, kind: 'webSocket' }
    });
    expectNoSecrets([forwarding, ooo, hours]);
  });

  it('over MCP: forwarding, OOO rules and hours', async () => {
    const forwarding = await tool('users.getForwarding', { id: fx.anna.id });
    expect(forwarding).toEqual({
      isError: false,
      content: { id: fx.anna.id, rules: markedRules() }
    });
    const scope = { kind: 'user', id: fx.anna.id };
    const ooo = await tool('ooo.list', { scope });
    expect(ooo.content.items).toEqual([
      expect.objectContaining({ target: { managed: true, kind: 'external' } })
    ]);
    const hours = await tool('hours.get', { scope });
    expect(hours.content.schedule).toMatchObject({
      closedTarget: { managed: true, kind: 'webSocket' }
    });
    expectNoSecrets([forwarding, ooo, hours]);
  });

  it('leaves admins and owners reading them in full', async () => {
    const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
    for (const actor of [admin, owner]) {
      // eslint-disable-next-line no-await-in-loop -- one actor after the other
      const forwarding = await rest(actor, 'GET', `${scopePath()}/forwarding`);
      expect(forwarding.body.rules).toEqual([
        { condition: 'busy', target: fx.sip },
        { condition: 'noAnswer', target: fx.webSocket },
        {
          condition: 'offline',
          target: { kind: 'mailboxUser', userId: fx.anna.id }
        }
      ]);
      // eslint-disable-next-line no-await-in-loop -- one actor after the other
      const ooo = await rest(actor, 'GET', `${scopePath()}/ooo`);
      expect(ooo.body.items).toEqual([
        expect.objectContaining({ target: fx.recorded })
      ]);
      // eslint-disable-next-line no-await-in-loop -- one actor after the other
      const hours = await rest(actor, 'GET', `${scopePath()}/hours`);
      expect(hours.body.schedule).toMatchObject({ closedTarget: fx.webSocket });
    }
  });
});

describe('a user sends the marker back', () => {
  it('over REST, keeping every admin-set target byte for byte while editing around it', async () => {
    const before = await targetRows(fx.db);
    const ids = await fx.db
      .selectFrom('userForwardRules')
      .select(['condition', 'targetId'])
      .orderBy('condition')
      .execute();
    const rules = [
      ...markedRules().slice(0, 2),
      { condition: 'dnd', target: { kind: 'mailboxUser', userId: fx.anna.id } }
    ];
    const put = await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, {
      rules
    });
    expect(put).toEqual({ status: 200, body: { id: fx.anna.id, rules } });
    const patch = await rest(fx.anna, 'PATCH', `/ooo/${fx.oooId}`, {
      active: true,
      target: { managed: true, kind: 'external' }
    });
    expect(patch.body).toMatchObject({
      active: true,
      target: { managed: true, kind: 'external' }
    });
    const hours = await rest(fx.anna, 'PUT', `${scopePath()}/hours`, {
      closedTarget: { managed: true, kind: 'webSocket' },
      intervals: []
    });
    expect(hours.body).toMatchObject({
      closedTarget: { managed: true, kind: 'webSocket' },
      intervals: []
    });
    expectNoSecrets([put, patch, hours]);

    const after = await targetRows(fx.db);
    // The kept rows are the very ones before; only `offline`'s went and `dnd`'s came.
    const offline = ids.find(row => row.condition === 'offline')?.targetId;
    expect(after.filter(row => (row as { id: string }).id !== offline)).toEqual(
      expect.arrayContaining(
        before.filter(row => (row as { id: string }).id !== offline)
      )
    );
    expect(after).toHaveLength(before.length);
    const idsAfter = await fx.db
      .selectFrom('userForwardRules')
      .select(['condition', 'targetId'])
      .where('condition', 'in', ['busy', 'noAnswer'])
      .orderBy('condition')
      .execute();
    expect(idsAfter).toEqual(ids.filter(row => row.condition !== 'offline'));
    // Admins still read them in full.
    const full = await rest(admin, 'GET', `${scopePath()}/forwarding`);
    expect(full.body.rules).toEqual([
      { condition: 'busy', target: fx.sip },
      { condition: 'noAnswer', target: fx.webSocket },
      { condition: 'dnd', target: { kind: 'mailboxUser', userId: fx.anna.id } }
    ]);
  });

  it('over MCP, keeping the targets', async () => {
    const before = await targetRows(fx.db);
    const scope = { kind: 'user', id: fx.anna.id };
    const set = await tool('users.setForwarding', {
      id: fx.anna.id,
      rules: markedRules()
    });
    expect(set).toEqual({
      isError: false,
      content: { id: fx.anna.id, rules: markedRules() }
    });
    expect(
      (
        await tool('ooo.update', {
          id: fx.oooId,
          target: { managed: true, kind: 'external' }
        })
      ).isError
    ).toBe(false);
    expect(
      (
        await tool('hours.set', {
          scope,
          closedTarget: { managed: true, kind: 'webSocket' },
          intervals: []
        })
      ).isError
    ).toBe(false);
    // The mailbox rule is written afresh; every admin-set row stays as it was.
    const after = await targetRows(fx.db);
    expect(after).toHaveLength(before.length);
    const admins = before.filter(
      row => (row as { mailboxUserId: string | null }).mailboxUserId === null
    );
    expect(after).toEqual(expect.arrayContaining(admins));
  });

  it('keeps an OOO rule’s admin-set target through a PATCH that leaves it out', async () => {
    const before = await targetRows(fx.db);
    const patch = await rest(fx.anna, 'PATCH', `/ooo/${fx.oooId}`, {
      active: true
    });
    expect(patch.status).toBe(200);
    expect(patch.body.target).toEqual({ managed: true, kind: 'external' });
    expect(await targetRows(fx.db)).toEqual(before);
  });

  it('removes an admin-set rule the user leaves out, its row with it', async () => {
    const put = await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, {
      rules: markedRules().slice(0, 1)
    });
    expect(put.status).toBe(200);
    const full = await rest(admin, 'GET', `${scopePath()}/forwarding`);
    expect(full.body.rules).toEqual([{ condition: 'busy', target: fx.sip }]);
    const urls = await fx.db
      .selectFrom('forwardTargets')
      .select('id')
      .where('webSocketUrl', '=', BOT_URL)
      .execute();
    // The hours' closed target alone names the bot now.
    expect(urls).toHaveLength(1);
  });

  it('refuses a marker where no admin-set target of its kind is held, with 422', async () => {
    const before = await targetRows(fx.db);
    const moved = await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, {
      rules: [{ condition: 'dnd', target: { managed: true, kind: 'sip' } }]
    });
    const wrongKind = await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, {
      rules: [
        { condition: 'busy', target: { managed: true, kind: 'webSocket' } }
      ]
    });
    const fresh = await rest(fx.anna, 'POST', `${scopePath()}/ooo`, {
      active: false,
      target: { managed: true, kind: 'external' }
    });
    for (const response of [moved, wrongKind, fresh]) {
      expect(response.status).toBe(422);
    }
    expect(await targetRows(fx.db)).toEqual(before);
  });
});

describe('a user sending an admin-set target in full', () => {
  it('gets 422 naming the marker, over REST and MCP, and changes nothing', async () => {
    const before = await targetRows(fx.db);
    const changed = { ...fx.webSocket, url: 'wss://evil.example/' };
    const responses = [
      await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, {
        rules: [{ condition: 'noAnswer', target: fx.webSocket }]
      }),
      await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, {
        rules: [{ condition: 'noAnswer', target: changed }]
      }),
      await rest(fx.anna, 'PATCH', `/ooo/${fx.oooId}`, { target: fx.recorded }),
      await rest(fx.anna, 'PUT', `${scopePath()}/hours`, {
        closedTarget: fx.webSocket,
        intervals: []
      })
    ];
    for (const response of responses) {
      expect(response.status).toBe(422);
    }
    expect(responses[0]?.body.title).toBe(
      'a webSocket target is set by an admin: to keep the one held here, send back the marker read in its place, { "managed": true, "kind": "webSocket" }'
    );
    expect(responses[2]?.body.title).toContain('"kind": "external"');
    const mcp = await tool('users.setForwarding', {
      id: fx.anna.id,
      rules: [{ condition: 'busy', target: { ...fx.sip, user: 'proj_mine' } }]
    });
    expect(mcp).toMatchObject({
      isError: true,
      content: {
        status: 422,
        title: expect.stringContaining('"managed": true') as string
      }
    });
    expect(await targetRows(fx.db)).toEqual(before);
  });

  it('still gets 403 for an admin target where none is held', async () => {
    const response = await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, {
      rules: [{ condition: 'dnd', target: fx.webSocket }]
    });
    expect(response.status).toBe(403);
  });

  it('leaves admins writing them in full, as before', async () => {
    const moved = { ...fx.webSocket, url: 'wss://other.example/' };
    const put = await rest(admin, 'PUT', `${scopePath()}/forwarding`, {
      rules: [{ condition: 'dnd', target: moved }]
    });
    expect(put).toEqual({
      status: 200,
      body: { id: fx.anna.id, rules: [{ condition: 'dnd', target: moved }] }
    });
  });
});

describe('an admin undoing a user’s change', () => {
  it('restores the admin-set targets in full', async () => {
    await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, { rules: [] });
    await rest(fx.anna, 'PATCH', `/ooo/${fx.oooId}`, {
      target: { kind: 'mailboxUser', userId: fx.anna.id }
    });
    await rest(fx.anna, 'PUT', `${scopePath()}/hours`, {
      closedTarget: { kind: 'mailboxUser', userId: fx.anna.id },
      intervals: []
    });
    const entries = await fx.db
      .selectFrom('auditLog')
      .select('id')
      .where('actorUserId', '=', fx.anna.id)
      .orderBy('id', 'desc')
      .execute();
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop -- newest first, as an admin undoes them
      await runOperation(
        fx.db,
        'audit.undo',
        { id: entry.id },
        asConfirmedRun({ actor: admin })
      );
    }
    const forwarding = await rest(admin, 'GET', `${scopePath()}/forwarding`);
    expect(forwarding.body.rules).toEqual([
      { condition: 'busy', target: fx.sip },
      { condition: 'noAnswer', target: fx.webSocket },
      {
        condition: 'offline',
        target: { kind: 'mailboxUser', userId: fx.anna.id }
      }
    ]);
    const ooo = await rest(admin, 'GET', `${scopePath()}/ooo`);
    expect(ooo.body.items).toEqual([
      expect.objectContaining({ target: fx.recorded })
    ]);
    const hours = await rest(admin, 'GET', `${scopePath()}/hours`);
    expect(hours.body.schedule).toMatchObject({ closedTarget: fx.webSocket });
  });

  it('restores the kept targets too, after a write that kept them by the marker', async () => {
    await rest(fx.anna, 'PUT', `${scopePath()}/forwarding`, {
      rules: markedRules().slice(0, 2)
    });
    const entry = await fx.db
      .selectFrom('auditLog')
      .select(['id', 'changesJson'])
      .where('actorUserId', '=', fx.anna.id)
      .executeTakeFirstOrThrow();
    // The entry records the kept targets in full, never the marker.
    expect(entry.changesJson).not.toContain('managed');
    await runOperation(
      fx.db,
      'audit.undo',
      { id: entry.id },
      asConfirmedRun({ actor: admin })
    );
    const forwarding = await rest(admin, 'GET', `${scopePath()}/forwarding`);
    expect(forwarding.body.rules).toHaveLength(3);
  });
});
