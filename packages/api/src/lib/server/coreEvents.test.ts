import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { nowIso, type Envelope } from '@zamfono/shared';

import { connectCoreEvents } from './coreEvents.js';

const RECONNECT_DELAY_MS = 20;
const WAIT_MS = 200;

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

function envelope(id: string): Envelope {
  return {
    id,
    at: nowIso(),
    type: 'trunk.status',
    trunkId: 't1',
    status: 'registered'
  };
}

describe('connectCoreEvents', () => {
  // eslint-disable-next-line init-declarations -- assigned in each test, closed in afterEach
  let wss: WebSocketServer;

  afterEach(async () => {
    await new Promise<void>(resolve => {
      wss.close(() => {
        resolve();
      });
    });
  });

  it('receives events and reconnects after the connection drops', async () => {
    let connectionCount = 0;
    wss = await listeningServer();
    wss.on('connection', socket => {
      connectionCount += 1;
      socket.send(
        JSON.stringify(envelope(connectionCount === 1 ? 'e1' : 'e2'))
      );
    });

    const received: Envelope[] = [];
    const connection = connectCoreEvents({
      url: serverUrl(wss),
      onEvent: ev => {
        received.push(ev);
      },
      reconnectDelayMs: RECONNECT_DELAY_MS
    });

    await wait(WAIT_MS);
    expect(received.map(ev => ev.id)).toEqual(['e1']);

    // Drop the connection from the server side to force a reconnect.
    const [firstClient] = wss.clients;
    if (firstClient === undefined) {
      throw new Error('coreEvents test: no connected client');
    }
    firstClient.terminate();

    await wait(WAIT_MS);
    expect(connectionCount).toBe(2);
    expect(received.map(ev => ev.id)).toEqual(['e1', 'e2']);

    connection.close();
  });

  it('hands asterisk.started to its own callback, never as an event, and reports every open', async () => {
    wss = await listeningServer();
    wss.on('connection', socket => {
      socket.send(
        JSON.stringify({
          type: 'asterisk.started',
          asteriskStartedAt: '2026-09-29T08:00:00.000Z'
        })
      );
      socket.send(JSON.stringify(envelope('e1')));
    });

    const received: Envelope[] = [];
    const started: string[] = [];
    let opens = 0;
    const connection = connectCoreEvents({
      url: serverUrl(wss),
      onEvent: ev => {
        received.push(ev);
      },
      onAsteriskStarted: at => {
        started.push(at);
      },
      onOpen: () => {
        opens += 1;
      },
      reconnectDelayMs: RECONNECT_DELAY_MS
    });

    await wait(WAIT_MS);
    expect(opens).toBe(1);
    expect(started).toEqual(['2026-09-29T08:00:00.000Z']);
    expect(received.map(ev => ev.id)).toEqual(['e1']);

    for (const client of wss.clients) {
      client.terminate();
    }
    await wait(WAIT_MS);
    expect(opens).toBe(2);

    connection.close();
  });
});
