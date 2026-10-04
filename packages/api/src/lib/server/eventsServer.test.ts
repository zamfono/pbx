import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { EventHub } from './events.js';
import { attachEventsServer } from './eventsServer.js';

// RFC 6455 §7.4.1: the close code of a frame too big to process.
const MESSAGE_TOO_BIG = 1009;

describe('attachEventsServer (§10.6)', () => {
  let server: http.Server;

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  it('closes a socket whose first frame is far larger than an auth frame, with 1009', async () => {
    const db = await migratedTestDb();
    server = http.createServer();
    attachEventsServer(server, {
      hub: new EventHub(db),
      db,
      jwtSecret: 'test-secret'
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/events`);
    await new Promise<void>(resolve => {
      client.once('open', () => {
        resolve();
      });
    });
    const closed = new Promise<number>(resolve => {
      client.once('close', code => {
        resolve(code);
      });
    });

    client.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(64 * 1024) }));

    expect(await closed).toBe(MESSAGE_TOO_BIG);
  });
});
