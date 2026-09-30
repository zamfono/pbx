// AMI text-protocol client over TCP: login, correlated actions and unsolicited events (§9.4).
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';

import type { Logger } from '../ari/types.js';
import {
  reconnectBackoff,
  type ReconnectBackoff
} from '../reconnectBackoff.js';

const FRAME_SEPARATOR = '\r\n\r\n';
const LINE_SEPARATOR = '\r\n';
const HEADER_SEPARATOR = ': ';
const COMPLETE_EVENT_SUFFIX = /complete$/iu;

export type AmiEvent = Record<string, string>;

export type AmiClientOptions = {
  host: string;
  port: number;
  username: string;
  password: string;
  log: Logger;
};

type PendingAction = {
  events: AmiEvent[];
  awaitEvents: boolean;
  resolve: (events: AmiEvent[]) => void;
  reject: (error: Error) => void;
};

function extractFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  let separatorIndex = rest.indexOf(FRAME_SEPARATOR);
  while (separatorIndex !== -1) {
    frames.push(rest.slice(0, separatorIndex));
    rest = rest.slice(separatorIndex + FRAME_SEPARATOR.length);
    separatorIndex = rest.indexOf(FRAME_SEPARATOR);
  }
  return { frames, rest };
}

function parseFrame(text: string): AmiEvent {
  const frame: AmiEvent = {};
  for (const line of text.split(LINE_SEPARATOR)) {
    const separatorIndex = line.indexOf(HEADER_SEPARATOR);
    if (separatorIndex === -1) {
      continue;
    }
    frame[line.slice(0, separatorIndex)] = line.slice(
      separatorIndex + HEADER_SEPARATOR.length
    );
  }
  return frame;
}

/**
 * AMI text-protocol client: logs in once connected, resolves `action()` calls by ActionID and
 * re-emits every unsolicited frame as `'event'`.
 */
export class AmiClient extends EventEmitter {
  private readonly options: AmiClientOptions;
  private socket: Socket | null = null;
  private buffer = '';
  private actionCounter = 0;
  private readonly pending = new Map<string, PendingAction>();
  private readonly reconnect: ReconnectBackoff;
  private closing = false;

  constructor(options: AmiClientOptions) {
    super();
    this.options = options;
    this.reconnect = reconnectBackoff(
      () => (this.closing ? Promise.resolve() : this.connectOnce()),
      (error: unknown) => {
        this.options.log.error({ error }, 'AMI reconnect failed');
      }
    );
  }

  connect(): Promise<void> {
    this.closing = false;
    return this.connectOnce();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.reconnect.cancel();
    this.rejectPending(new Error('AMI client closed'));
    const socket = this.socket;
    if (!socket) {
      return;
    }
    await new Promise<void>(resolve => {
      socket.once('close', () => {
        resolve();
      });
      socket.end();
    });
  }

  action(name: string, params?: Record<string, string>): Promise<AmiEvent[]> {
    return this.sendAction(name, params, true);
  }

  private login(): Promise<void> {
    return this.sendAction(
      'Login',
      { Username: this.options.username, Secret: this.options.password },
      false
    ).then(() => undefined);
  }

  private sendAction(
    name: string,
    params: Record<string, string> | undefined,
    awaitEvents: boolean
  ): Promise<AmiEvent[]> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new Error('AMI client is not connected'));
    }
    this.actionCounter += 1;
    const actionId = `${this.actionCounter}`;
    const lines = [`Action: ${name}`, `ActionID: ${actionId}`];
    for (const [key, value] of Object.entries(params ?? {})) {
      lines.push(`${key}: ${value}`);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(actionId, { events: [], awaitEvents, resolve, reject });
      socket.write(`${lines.join(LINE_SEPARATOR)}${FRAME_SEPARATOR}`);
    });
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({
        host: this.options.host,
        port: this.options.port
      });
      this.socket = socket;
      let loggedIn = false;

      socket.on('connect', () => {
        this.login()
          .then(() => {
            loggedIn = true;
            this.reconnect.reset();
            this.emit('connected');
            resolve();
          })
          .catch(reject);
      });
      socket.on('data', (chunk: Buffer) => {
        this.handleData(chunk.toString('utf8'));
      });
      socket.on('close', () => {
        this.socket = null;
        this.rejectPending(new Error('AMI connection closed'));
        this.emit('disconnected');
        if (!this.closing) {
          this.reconnect.schedule();
        }
        if (!loggedIn) {
          reject(new Error('AMI connection closed before login completed'));
        }
      });
      socket.on('error', (error: Error) => {
        this.options.log.error({ error: error.message }, 'AMI socket error');
      });
    });
  }

  private rejectPending(error: Error): void {
    for (const action of this.pending.values()) {
      action.reject(error);
    }
    this.pending.clear();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const { frames, rest } = extractFrames(this.buffer);
    this.buffer = rest;
    for (const frameText of frames) {
      this.routeFrame(parseFrame(frameText));
    }
  }

  private routeFrame(frame: AmiEvent): void {
    if (!('ActionID' in frame)) {
      this.emit('event', frame);
      return;
    }
    const actionId = frame.ActionID;
    const action = this.pending.get(actionId);
    if (!action) {
      this.emit('event', frame);
      return;
    }
    if (frame.Response === 'Error') {
      action.reject(
        new Error('Message' in frame ? frame.Message : 'AMI action failed')
      );
      this.pending.delete(actionId);
      return;
    }
    if (!action.awaitEvents) {
      if (frame.Response === 'Success') {
        action.resolve(action.events);
        this.pending.delete(actionId);
      }
      return;
    }
    if (!('Event' in frame)) {
      return;
    }
    action.events.push(frame);
    if (COMPLETE_EVENT_SUFFIX.test(frame.Event)) {
      action.resolve(action.events);
      this.pending.delete(actionId);
    }
  }
}
