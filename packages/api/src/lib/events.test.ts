import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { newId, nowIso, openDb, type Db, type Envelope } from '@zamfono/shared';
import { migrateForTest } from '@zamfono/shared/testDb.js';

import { signAccessToken } from './auth/jwt.js';
import { EventHub, rawDataToString, visibleTo } from './events.js';
import { authenticateEventsSocket } from './eventsAuth.js';
import type { Actor } from './ops/types.js';

const JWT_SECRET = 'test-secret';
const SHORT_TIMEOUT_MS = 30;
const FAN_OUT_WAIT_MS = 40;
const NOW_S = Math.floor(Date.now() / 1000);

/**
 * A WebSocket server on whatever port is free, once it listens: a fixed port can already be held
 * by another suite running on the same host.
 */
async function listeningServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => {
    server.once('listening', () => {
      resolve();
    });
  });
  return server;
}

function serverUrl(server: WebSocketServer): string {
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** A migrated in-memory database with one user, for token verification and membership checks. */
async function migratedDb(userId: string): Promise<Db> {
  const db = openDb(':memory:');
  await migrateForTest(db);
  await db
    .insertInto('users')
    .values({
      id: userId,
      name: 'A User',
      email: `${userId}@example.com`,
      role: 'user',
      createdAt: nowIso()
    })
    .execute();
  return db;
}

describe('visibleTo', () => {
  const admin: Actor = { id: 'admin-1', name: 'Admin', role: 'admin' };
  const user: Actor = { id: 'user-1', name: 'User', role: 'user' };

  it('shows an admin every event', () => {
    const ev: Envelope = {
      id: 'e1',
      at: nowIso(),
      type: 'backup.failed',
      targetId: 't1',
      runId: 'r1',
      error: 'boom'
    };
    expect(visibleTo(admin, ev)).toBe(true);
  });

  it('shows a user their own presence and call, not another user’s', () => {
    const ownPresence: Envelope = {
      id: 'e1',
      at: nowIso(),
      type: 'presence',
      userId: user.id,
      status: 'busy',
      peer: null,
      ringGroupId: null
    };
    const otherCall: Envelope = {
      id: 'e2',
      at: nowIso(),
      type: 'call.state',
      callId: 'c1',
      state: 'up',
      peer: null,
      ringGroupId: null,
      userId: 'someone-else',
      userIds: ['someone-else']
    };
    expect(visibleTo(user, ownPresence)).toBe(true);
    expect(visibleTo(user, otherCall)).toBe(false);
  });

  it('shows a user a call they took part in though `userId` names another (§10.6 "own calls")', () => {
    // The caller of a call someone else answered: `userId` is the answerer's.
    const placedCall: Envelope = {
      id: 'e3',
      at: nowIso(),
      type: 'call.state',
      callId: 'c2',
      state: 'up',
      peer: '+15550100',
      ringGroupId: null,
      userId: 'someone-else',
      userIds: [user.id, 'someone-else']
    };
    expect(visibleTo(user, placedCall)).toBe(true);
  });

  it('shows a user only the tenant-scope ooo and hours events', () => {
    const tenantOoo: Envelope = {
      id: 'e1',
      at: nowIso(),
      type: 'ooo',
      scope: 'tenant',
      active: true,
      startsAt: null,
      expiresAt: null
    };
    const ringGroupHours: Envelope = {
      id: 'e2',
      at: nowIso(),
      type: 'hours',
      scope: 'ringGroup:g1',
      open: false
    };
    expect(visibleTo(user, tenantOoo)).toBe(true);
    expect(visibleTo(user, ringGroupHours)).toBe(false);
  });

  it('hides trunk and backup events from a user', () => {
    const ev: Envelope = {
      id: 'e1',
      at: nowIso(),
      type: 'trunk.status',
      trunkId: 't1',
      status: 'unreachable'
    };
    expect(visibleTo(user, ev)).toBe(false);
  });
});

describe('authenticateEventsSocket', () => {
  // eslint-disable-next-line init-declarations -- assigned in each test, closed in afterEach
  let wss: WebSocketServer;

  afterEach(async () => {
    await new Promise<void>(resolve => {
      wss.close(() => {
        resolve();
      });
    });
  });

  it('closes a socket that sends nothing within the timeout', async () => {
    const db = await migratedDb('u1');
    wss = await listeningServer();
    const serverResult = new Promise<Actor | null>(resolve => {
      wss.once('connection', socket => {
        authenticateEventsSocket(socket, {
          db,
          jwtSecret: JWT_SECRET,
          timeoutMs: SHORT_TIMEOUT_MS
        }).then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    const clientClosed = new Promise<void>(resolve => {
      client.once('close', () => {
        resolve();
      });
    });
    expect(await serverResult).toBeNull();
    await clientClosed;
  });

  it('closes a socket whose first frame is not the auth frame', async () => {
    const db = await migratedDb('u1');
    wss = await listeningServer();
    const serverResult = new Promise<Actor | null>(resolve => {
      wss.once('connection', socket => {
        authenticateEventsSocket(socket, {
          db,
          jwtSecret: JWT_SECRET
        }).then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    client.send(JSON.stringify({ hello: 'world' }));
    expect(await serverResult).toBeNull();
  });

  it('resolves the actor a valid auth frame names', async () => {
    const db = await migratedDb('u1');
    wss = await listeningServer();
    const serverResult = new Promise<Actor | null>(resolve => {
      wss.once('connection', socket => {
        authenticateEventsSocket(socket, {
          db,
          jwtSecret: JWT_SECRET
        }).then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    const token = signAccessToken(
      JWT_SECRET,
      { sub: 'u1', role: 'user', cid: null },
      NOW_S,
      'https://pbx.example.com/mcp'
    );
    client.send(JSON.stringify({ type: 'auth', token }));
    expect(await serverResult).toEqual({
      id: 'u1',
      name: 'A User',
      role: 'user'
    });
    client.close();
  });

  it('closes a socket whose token does not verify', async () => {
    const db = await migratedDb('u1');
    wss = await listeningServer();
    const serverResult = new Promise<Actor | null>(resolve => {
      wss.once('connection', socket => {
        authenticateEventsSocket(socket, {
          db,
          jwtSecret: JWT_SECRET
        }).then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    client.send(JSON.stringify({ type: 'auth', token: 'not-a-real-token' }));
    expect(await serverResult).toBeNull();
  });
});

describe('EventHub', () => {
  // eslint-disable-next-line init-declarations -- assigned in each test, closed in afterEach
  let wss: WebSocketServer;

  afterEach(async () => {
    await new Promise<void>(resolve => {
      wss.close(() => {
        resolve();
      });
    });
  });

  it('delivers to a user only what visibleTo admits', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { id: 'u1', name: 'A User', role: 'user' })
          .then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    await subscribed;
    const received: Envelope[] = [];
    client.on('message', data => {
      received.push(JSON.parse(rawDataToString(data)) as Envelope);
    });

    hub.publish({
      id: newId(),
      at: nowIso(),
      type: 'presence',
      userId: 'u1',
      status: 'available',
      peer: null,
      ringGroupId: null
    });
    hub.publish({
      id: newId(),
      at: nowIso(),
      type: 'call.state',
      callId: 'c1',
      state: 'up',
      peer: null,
      ringGroupId: null,
      userId: 'someone-else',
      userIds: ['someone-else']
    });
    hub.publish({
      id: newId(),
      at: nowIso(),
      type: 'ooo',
      scope: 'tenant',
      active: false,
      startsAt: null,
      expiresAt: null
    });

    await wait(FAN_OUT_WAIT_MS);
    expect(received.map(ev => ev.type)).toEqual(['presence', 'ooo']);
    client.close();
  });

  it('delivers a user the call.state of a call they placed, in the §10.6 shape', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { id: 'u1', name: 'A User', role: 'user' })
          .then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    await subscribed;
    const received: Record<string, unknown>[] = [];
    client.on('message', data => {
      received.push(
        JSON.parse(rawDataToString(data)) as Record<string, unknown>
      );
    });

    // u1 dialled out; nobody answered as a user, so `userId` names no one.
    hub.publish({
      id: newId(),
      at: nowIso(),
      type: 'call.state',
      callId: 'c1',
      state: 'ringing',
      peer: '+15550100',
      ringGroupId: null,
      userId: null,
      userIds: ['u1']
    });

    await wait(FAN_OUT_WAIT_MS);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'call.state', callId: 'c1' });
    // The participant list routes the event; subscribers get the fields §10.6 lists.
    expect(received[0]).not.toHaveProperty('userIds');
    client.close();
  });

  it('delivers a ring group’s voicemail.new to a member', async () => {
    const db = await migratedDb('u1');
    await db
      .insertInto('ringGroups')
      .values({
        id: 'g1',
        name: 'Sales',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId: 'g1', userId: 'u1', position: 0 })
      .execute();
    const hub = new EventHub(db);
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { id: 'u1', name: 'A User', role: 'user' })
          .then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    await subscribed;
    const received = new Promise<string>(resolve => {
      client.once('message', data => {
        resolve(rawDataToString(data));
      });
    });

    hub.publish({
      id: newId(),
      at: nowIso(),
      type: 'voicemail.new',
      voicemailId: 'vm1',
      mailbox: 'ringGroup:g1'
    });

    expect(JSON.parse(await received)).toMatchObject({ voicemailId: 'vm1' });
    client.close();
  });

  it('delivers a ring group’s voicemail.new to a member reached through a nested user group', async () => {
    const db = await migratedDb('u1');
    await db
      .insertInto('userGroups')
      .values([
        { id: 'child', name: 'Child', createdAt: nowIso() },
        { id: 'parent', name: 'Parent', createdAt: nowIso() }
      ])
      .execute();
    await db
      .insertInto('userGroupUsers')
      .values({ groupId: 'child', userId: 'u1' })
      .execute();
    await db
      .insertInto('userGroupGroups')
      .values({ parentGroupId: 'parent', childGroupId: 'child' })
      .execute();
    await db
      .insertInto('ringGroups')
      .values({
        id: 'g1',
        name: 'Sales',
        strategy: 'simultaneous',
        createdAt: nowIso()
      })
      .execute();
    await db
      .insertInto('ringGroupMembers')
      .values({ groupId: 'g1', userGroupId: 'parent', position: 0 })
      .execute();
    const hub = new EventHub(db);
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { id: 'u1', name: 'A User', role: 'user' })
          .then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    await subscribed;
    const received = new Promise<string>(resolve => {
      client.once('message', data => {
        resolve(rawDataToString(data));
      });
    });

    hub.publish({
      id: newId(),
      at: nowIso(),
      type: 'voicemail.new',
      voicemailId: 'vm2',
      mailbox: 'ringGroup:g1'
    });

    expect(JSON.parse(await received)).toMatchObject({ voicemailId: 'vm2' });
    client.close();
  });
});
