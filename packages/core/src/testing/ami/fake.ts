// In-process fake AMI server: enough of the text protocol for AmiClient's tests.
import { createServer, type Server, type Socket } from 'node:net';

import { splitFrames, writeFrame, type AmiEvent } from '#src/ami/frame.js';

type Registration = {
  ObjectName: string;
  ClientUri: string;
  ServerUri: string;
  Status: 'Registered' | 'Rejected' | 'Unregistered' | 'Failed';
};

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
