import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import {
  addMsIso,
  epochSeconds,
  newId,
  nowIso,
  rawDataToString,
  type Db,
  type Envelope
} from '@zamfono/shared';
import { migratedTestDb, seedUser } from '@zamfono/shared/testDb.js';

import type { Authenticated } from './auth/bearer.js';
import { signAccessToken } from './auth/jwt.js';
import {
  issueRefresh,
  rotateRefresh,
  type IssuedRefresh
} from './auth/tokens.js';
import { EventHub, visibleTo } from './events.js';
import { authenticateEventsSocket } from './eventsAuth.js';
import type { Actor } from './ops/types.js';

const JWT_SECRET = 'test-secret';
const SHORT_TIMEOUT_MS = 30;
const FAN_OUT_WAIT_MS = 40;
// §10.6: the close code of a socket whose user is gone or whose role changed.
const USER_CHANGED_CLOSE_CODE = 4401;
const NOW_S = epochSeconds(Date.now());

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
  const db = await migratedTestDb();
  await seedUser(db, { id: userId, name: 'A User' });
  return db;
}

const U1: Actor = { id: 'u1', name: 'A User', role: 'user' };

/** A session of `u1` with an OAuth client, as the token endpoint starts it on a login. */
async function seedSession(db: Db): Promise<IssuedRefresh> {
  await db
    .insertInto('oauthClients')
    .values({
      clientId: 'client-1',
      name: 'Ops Console',
      kind: 'cimd',
      createdAt: nowIso(),
      lastLoginAt: nowIso()
    })
    .execute();
  return issueRefresh(db, 'u1', 'client-1', nowIso());
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
      legs: [],
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
      legs: [],
      state: 'up',
      peer: '+15550100',
      ringGroupId: null,
      userId: 'someone-else',
      userIds: [user.id, 'someone-else']
    };
    expect(visibleTo(user, placedCall)).toBe(true);
  });

  it('shows the users it names alone a call that stopped or started being theirs (§10.6)', () => {
    // A ring-group member whose leg stopped ringing while the call rings on for the others.
    const left: Envelope = {
      id: 'e4',
      at: nowIso(),
      type: 'call.state',
      callId: 'c3',
      legs: [],
      state: 'ended',
      peer: '+15550100',
      ringGroupId: 'group-1',
      userId: null,
      userIds: [user.id],
      usersOnly: true
    };
    expect(visibleTo(user, left)).toBe(true);
    expect(visibleTo({ ...user, id: 'user-2' }, left)).toBe(false);
    expect(visibleTo(admin, left)).toBe(false);
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
    const serverResult = new Promise<Authenticated | null>(resolve => {
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
    const serverResult = new Promise<Authenticated | null>(resolve => {
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
    const { sessionId } = await seedSession(db);
    wss = await listeningServer();
    const serverResult = new Promise<Authenticated | null>(resolve => {
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
    const token = await signAccessToken(
      JWT_SECRET,
      { sub: 'u1', role: 'user', cid: null, sid: sessionId },
      NOW_S,
      'https://pbx.example.com'
    );
    client.send(JSON.stringify({ type: 'auth', token }));
    expect(await serverResult).toEqual({
      actor: { id: 'u1', name: 'A User', role: 'user' },
      sessionId
    });
    client.close();
  });

  it('closes a socket whose token does not verify', async () => {
    const db = await migratedDb('u1');
    wss = await listeningServer();
    const serverResult = new Promise<Authenticated | null>(resolve => {
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
    const { sessionId } = await seedSession(db);
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { actor: U1, sessionId })
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
      legs: [],
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

  it('drops a socket whose unsent backlog has outgrown the limit, sending it nothing more', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    const { sessionId } = await seedSession(db);
    wss = await listeningServer();
    const subscribed = new Promise<WebSocket>(resolve => {
      wss.once('connection', socket => {
        hub.subscribeWs(socket, { actor: U1, sessionId }).then(
          () => {
            resolve(socket);
          },
          () => {
            resolve(socket);
          }
        );
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    const serverSocket = await subscribed;
    // A client that stopped reading: what `ws` has not handed to the kernel yet piles up.
    Object.defineProperty(serverSocket, 'bufferedAmount', {
      value: 64 * 1024 * 1024
    });
    let received = 0;
    client.on('message', () => {
      received += 1;
    });
    const closed = new Promise<void>(resolve => {
      client.once('close', () => {
        resolve();
      });
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

    await closed;
    expect(received).toBe(0);
  });

  it('delivers a user the call.state of a call they placed, in the §10.6 shape', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    const { sessionId } = await seedSession(db);
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { actor: U1, sessionId })
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
      legs: [],
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
    const { sessionId } = await seedSession(db);
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { actor: U1, sessionId })
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
    const { sessionId } = await seedSession(db);
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { actor: U1, sessionId })
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

describe('EventHub.usersChanged (§10.6)', () => {
  let wss: WebSocketServer;

  afterEach(async () => {
    await new Promise<void>(resolve => {
      wss.close(() => {
        resolve();
      });
    });
  });

  /** A client connected to `hub` as `auth`, once the hub holds its socket. */
  async function subscribedClient(
    hub: EventHub,
    auth: Authenticated
  ): Promise<WebSocket> {
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub.subscribeWs(socket, auth).then(resolve, resolve);
      });
    });
    const client = new WebSocket(serverUrl(wss));
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    await subscribed;
    return client;
  }

  function closeCode(client: WebSocket): Promise<number> {
    return new Promise(resolve => {
      client.once('close', code => {
        resolve(code);
      });
    });
  }

  /** `u1` on a live session, as an access token's handshake hands it to the hub. */
  async function sessionAuth(
    db: Db,
    actor: Actor = U1
  ): Promise<Authenticated> {
    return { actor, sessionId: (await seedSession(db)).sessionId };
  }

  it('closes with 4401 the socket of a user whose role changed', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    const client = await subscribedClient(
      hub,
      await sessionAuth(db, { ...U1, role: 'admin' })
    );
    const closed = closeCode(client);

    await hub.usersChanged();

    expect(await closed).toBe(USER_CHANGED_CLOSE_CODE);
  });

  it('closes with 4401 the socket of a soft-deleted user', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    const client = await subscribedClient(hub, await sessionAuth(db));
    const closed = closeCode(client);
    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'u1')
      .execute();

    await hub.usersChanged();

    expect(await closed).toBe(USER_CHANGED_CLOSE_CODE);
  });

  it('stops a ring group’s voicemail.new reaching a user removed from it', async () => {
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
    const client = await subscribedClient(hub, await sessionAuth(db));
    const messages: string[] = [];
    client.on('message', data => {
      messages.push(rawDataToString(data));
    });
    await db.deleteFrom('ringGroupMembers').execute();

    await hub.usersChanged();
    hub.publish({
      id: newId(),
      at: nowIso(),
      type: 'voicemail.new',
      voicemailId: 'vm3',
      mailbox: 'ringGroup:g1'
    });
    await wait(FAN_OUT_WAIT_MS);

    expect(messages).toEqual([]);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('keeps the socket of a session open across its refresh-token rotations', async () => {
    const db = await migratedDb('u1');
    const session = await seedSession(db);
    const hub = new EventHub(db);
    const client = await subscribedClient(hub, {
      actor: U1,
      sessionId: session.sessionId
    });
    const rotated = await rotateRefresh(db, session.raw, nowIso());
    expect(rotated.ok).toBe(true);

    await hub.usersChanged();

    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('closes with 4401 the socket of a session revoked since, and keeps another session’s', async () => {
    const db = await migratedDb('u1');
    const revoked = await seedSession(db);
    const other = await issueRefresh(db, 'u1', 'client-1', nowIso());
    const hub = new EventHub(db);
    const ended = await subscribedClient(hub, {
      actor: U1,
      sessionId: revoked.sessionId
    });
    const closed = closeCode(ended);
    const kept = new WebSocket(serverUrl(wss));
    const keptSubscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        hub
          .subscribeWs(socket, { actor: U1, sessionId: other.sessionId })
          .then(resolve, resolve);
      });
    });
    await keptSubscribed;
    await db
      .updateTable('tokens')
      .set({ revokedAt: nowIso() })
      .where('sessionId', '=', revoked.sessionId)
      .execute();

    await hub.usersChanged();

    expect(await closed).toBe(USER_CHANGED_CLOSE_CODE);
    expect(kept.readyState).toBe(WebSocket.OPEN);
    kept.close();
  });

  /** A personal access token of `u1`, as the `/events` handshake hands it to the hub. */
  async function seedToken(
    db: Db,
    expiresAt: string | null
  ): Promise<Authenticated> {
    await db
      .insertInto('personalAccessTokens')
      .values({
        id: 'pat-1',
        tokenHash: 'hash-1',
        userId: 'u1',
        name: 'crm-sync',
        createdAt: nowIso(),
        expiresAt
      })
      .execute();
    return { actor: U1, personalAccessToken: { id: 'pat-1', expiresAt } };
  }

  it('closes with 4401 the socket of a personal access token revoked since', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    const client = await subscribedClient(hub, await seedToken(db, null));
    const closed = closeCode(client);
    await db
      .updateTable('personalAccessTokens')
      .set({ revokedAt: nowIso() })
      .execute();

    await hub.usersChanged();

    expect(await closed).toBe(USER_CHANGED_CLOSE_CODE);
  });

  it('keeps the socket of a live personal access token open', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    const client = await subscribedClient(hub, await seedToken(db, null));

    await hub.usersChanged();

    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('closes with 4401 the socket of a personal access token once it reaches expiresAt, with no write in between', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    const expiresAt = addMsIso(nowIso(), SHORT_TIMEOUT_MS);
    const client = await subscribedClient(hub, await seedToken(db, expiresAt));

    expect(await closeCode(client)).toBe(USER_CHANGED_CLOSE_CODE);
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(expiresAt));
  });

  it('closes with 4401 a socket whose session was revoked while the hub was taking it on', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    // The handshake found the session live; its revocation commits right after.
    const auth = await sessionAuth(db);
    await db
      .updateTable('tokens')
      .set({ revokedAt: nowIso() })
      .where('sessionId', '=', auth.sessionId ?? '')
      .execute();
    wss = await listeningServer();
    const subscribed = new Promise<void>(resolve => {
      wss.once('connection', socket => {
        // The revocation's re-check runs while the hub reads the user's ring groups.
        Promise.all([hub.subscribeWs(socket, auth), hub.usersChanged()]).then(
          () => {
            resolve();
          },
          () => {
            resolve();
          }
        );
      });
    });
    const client = new WebSocket(serverUrl(wss));
    const closed = Promise.race([
      closeCode(client),
      new Promise<null>(resolve => {
        setTimeout(() => {
          resolve(null);
        }, 500);
      })
    ]);
    await subscribed;
    const code = await closed;
    client.terminate();

    expect(code).toBe(USER_CHANGED_CLOSE_CODE);
  });

  it('does not take on a socket that closed during its handshake', async () => {
    const db = await migratedDb('u1');
    const hub = new EventHub(db);
    const auth = await sessionAuth(db);
    wss = await listeningServer();
    const gone = new Promise<WebSocket>(resolve => {
      wss.once('connection', socket => {
        socket.once('close', () => {
          resolve(socket);
        });
      });
    });
    const client = new WebSocket(serverUrl(wss));
    client.once('open', () => {
      client.terminate();
    });
    const socket = await gone;
    await hub.subscribeWs(socket, auth);
    const close = vi.spyOn(socket, 'close');
    await db
      .updateTable('users')
      .set({ deletedAt: nowIso() })
      .where('id', '=', 'u1')
      .execute();

    await hub.usersChanged();

    // A socket the hub held would be closed with 4401 here.
    expect(close).not.toHaveBeenCalled();
  });
});
