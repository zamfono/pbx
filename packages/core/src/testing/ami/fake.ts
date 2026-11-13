// In-process fake AMI server: enough of the text protocol for AmiClient's tests.
import { createServer, type Server, type Socket } from 'node:net';

import { splitFrames, writeFrame, type AmiEvent } from '#src/ami/frame.js';

type Registration = {
  ObjectName: string;
  ClientUri: string;
  ServerUri: string;
  Status: 'Registered' | 'Rejected' | 'Unregistered' | 'Failed';
};

/**
 * An `InvalidAccountID` security event as Asterisk 22 writes it to AMI (`security_events.c`):
 * its fields in order, each value unescaped, so an `accountId` holding CR/LF stands in it as it is.
 */
export function invalidAccountIdText(
  accountId: string,
  remoteAddress: string
): string {
  const lines = [
    'Event: InvalidAccountID',
    'Privilege: security,all',
    'EventTV: 2026-11-13T09:00:00.000+0000',
    'Severity: Error',
    'Service: PJSIP',
    'EventVersion: 1',
    `AccountID: ${accountId}`,
    'SessionID: 3f2a9c1e-scan@192.0.2.66',
    'LocalAddress: IPV4/UDP/198.51.100.10/5060',
    `RemoteAddress: ${remoteAddress}`
  ];
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export class FakeAmi {
  readonly registrations: Registration[] = [];
  /** Every action received after login, in order. */
  readonly actions: AmiEvent[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer(socket => {
        this.sockets.add(socket);
        let buffer = '';
        socket.on('data', (chunk: Buffer) => {
          const { frames, rest } = splitFrames(buffer + chunk.toString('utf8'));
          buffer = rest;
          for (const frame of frames) {
            this.handleFrame(socket, frame);
          }
        });
        socket.on('close', () => {
          this.sockets.delete(socket);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('FakeAmi failed to bind to a port'));
          return;
        }
        this.server = server;
        resolve({ host: '127.0.0.1', port: address.port });
      });
    });
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Test-only: drop every connected socket while the server keeps listening, so a client can reconnect. */
  disconnectClient(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  /** Writes `event` as Asterisk writes an event: `Event`, then `Privilege`, then the rest. */
  emit(event: AmiEvent): void {
    this.write(writeFrame({ Event: '', Privilege: 'system,all', ...event }));
  }

  /** Writes `text` as it stands, for frames Asterisk writes with a field that holds CR/LF. */
  write(text: string): void {
    for (const socket of this.sockets) {
      socket.write(text);
    }
  }

  private handleFrame(socket: Socket, frame: AmiEvent): void {
    const actionId = 'ActionID' in frame ? frame.ActionID : '';
    if (frame.Action === 'Login') {
      socket.write(
        writeFrame({
          Response: 'Success',
          ActionID: actionId,
          Message: 'Authentication accepted'
        })
      );
      return;
    }
    this.actions.push(frame);
    if (
      frame.Action === 'PJSIPRegister' &&
      !this.registrations.some(
        registration => registration.ObjectName === frame.Registration
      )
    ) {
      // Asterisk's answer for a registration it holds no state for.
      socket.write(
        writeFrame({
          Response: 'Error',
          ActionID: actionId,
          Message: 'Unable to retrieve registration entry'
        })
      );
      return;
    }
    if (frame.Action === 'PJSIPShowRegistrationsOutbound') {
      this.replyRegistrations(socket, actionId);
      return;
    }
    socket.write(writeFrame({ Response: 'Success', ActionID: actionId }));
  }

  private replyRegistrations(socket: Socket, actionId: string): void {
    socket.write(
      writeFrame({
        Response: 'Success',
        ActionID: actionId,
        Message: 'Registrations will follow'
      })
    );
    for (const registration of this.registrations) {
      socket.write(
        writeFrame({
          Event: 'OutboundRegistrationDetail',
          ActionID: actionId,
          ...registration
        })
      );
    }
    socket.write(
      writeFrame({
        Event: 'RegistrationsComplete',
        ActionID: actionId,
        EventList: 'Complete'
      })
    );
  }
}
