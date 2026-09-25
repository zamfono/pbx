// In-process fake AMI server: enough of the text protocol for AmiClient's tests.
import { createServer, type Server, type Socket } from 'node:net';

import type { AmiEvent } from './client.js';

const FRAME_SEPARATOR = '\r\n\r\n';
const LINE_SEPARATOR = '\r\n';
const HEADER_SEPARATOR = ': ';

type Registration = {
  ObjectName: string;
  ClientUri: string;
  ServerUri: string;
  Status: 'Registered' | 'Rejected' | 'Unregistered' | 'Failed';
};

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

function writeFrame(frame: AmiEvent): string {
  const lines = Object.entries(frame).map(
    ([key, value]) => `${key}${HEADER_SEPARATOR}${value}`
  );
  return `${lines.join(LINE_SEPARATOR)}${FRAME_SEPARATOR}`;
}

export class FakeAmi {
  readonly registrations: Registration[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer(socket => {
        this.sockets.add(socket);
        let buffer = '';
        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let separatorIndex = buffer.indexOf(FRAME_SEPARATOR);
          while (separatorIndex !== -1) {
            this.handleFrame(
              socket,
              parseFrame(buffer.slice(0, separatorIndex))
            );
            buffer = buffer.slice(separatorIndex + FRAME_SEPARATOR.length);
            separatorIndex = buffer.indexOf(FRAME_SEPARATOR);
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

  emit(event: AmiEvent): void {
    for (const socket of this.sockets) {
      socket.write(writeFrame(event));
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
