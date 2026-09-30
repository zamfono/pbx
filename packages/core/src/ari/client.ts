// Thin ARI client: a WebSocket event stream plus REST wrappers over Asterisk's ARI (§3, §9.2).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import {
  reconnectBackoff,
  type ReconnectBackoff
} from '../reconnectBackoff.js';
import { buildRestApi } from './restApi.js';
import { ariRequests, authHeaders } from './restTransport.js';
import {
  rawDataToString,
  tryParseAriEvent,
  type AsteriskApi,
  type BridgesApi,
  type ChannelsApi,
  type DeviceStatesApi,
  type EndpointsApi,
  type Logger,
  type MailboxesApi,
  type PlaybacksApi
} from './types.js';

export type AriClientOptions = {
  url: string;
  user: string;
  password: string;
  app: 'zamfono';
  log: Logger;
};

/**
 * Thin ARI client: connects to the events WebSocket and re-emits every frame as `'event'`,
 * and exposes the REST surface Asterisk 22's ARI offers as promise-returning namespaces.
 */
export class AriClient extends EventEmitter {
  readonly channels: ChannelsApi;
  readonly bridges: BridgesApi;
  readonly playbacks: PlaybacksApi;
  readonly deviceStates: DeviceStatesApi;
  readonly mailboxes: MailboxesApi;
  readonly endpoints: EndpointsApi;
  readonly asterisk: AsteriskApi;
  private readonly options: AriClientOptions;
  private socket: WebSocket | null = null;
  private readonly reconnect: ReconnectBackoff;
  private closing = false;

  constructor(options: AriClientOptions) {
    super();
    this.options = options;
    this.reconnect = reconnectBackoff(
      () => (this.closing ? Promise.resolve() : this.connectOnce()),
      (error: unknown) => {
        this.options.log.error({ error }, 'ARI reconnect failed');
      }
    );
    const api = buildRestApi(ariRequests(options));
    this.channels = api.channels;
    this.bridges = api.bridges;
    this.playbacks = api.playbacks;
    this.deviceStates = api.deviceStates;
    this.mailboxes = api.mailboxes;
    this.endpoints = api.endpoints;
    this.asterisk = api.asterisk;
  }

  connect(): Promise<void> {
    this.closing = false;
    return this.connectOnce();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.reconnect.cancel();
    const socket = this.socket;
    if (!socket) {
      return;
    }
    await new Promise<void>(resolve => {
      socket.once('close', () => {
        resolve();
      });
      socket.close();
    });
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.buildWsUrl(), {
        headers: authHeaders(this.options)
      });
      this.socket = socket;
      let opened = false;

      socket.on('open', () => {
        opened = true;
        this.reconnect.reset();
        this.emit('connected');
        resolve();
      });
      socket.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(rawDataToString(data));
      });
      socket.on('close', () => {
        this.socket = null;
        this.emit('disconnected');
        if (!this.closing) {
          this.reconnect.schedule();
        }
        if (!opened) {
          reject(new Error('ARI WebSocket closed before it opened'));
        }
      });
      socket.on('error', (error: Error) => {
        this.options.log.error({ error: error.message }, 'ARI WebSocket error');
      });
    });
  }

  private handleMessage(raw: string): void {
    const event = tryParseAriEvent(raw, this.options.log);
    if (event === null) {
      return;
    }
    this.emit('event', event);
  }

  private buildWsUrl(): string {
    const wsUrl = new URL(`${this.options.url.replace(/\/$/u, '')}/events`);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('app', this.options.app);
    wsUrl.searchParams.set('subscribeAll', 'true');
    return wsUrl.toString();
  }
}
