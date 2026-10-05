/**
 * A stand-in for `node:https`'s `request`, for tests that mock that module: it resolves the host
 * through the request's own `lookup` option, as the socket would, and fails the request when that
 * refuses; otherwise `serve` answers it. Nothing here touches the network.
 */
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/** What `serve` answers a request with: 200 and no headers unless it says otherwise. */
export type FakeResponse = {
  status?: number;
  headers?: Record<string, string>;
  body: string;
};

type RequestFn = (
  url: string | URL,
  options: RequestOptions,
  onResponse?: (response: IncomingMessage) => void
) => ClientRequest;

/** Settles once `lookup` has answered for `hostname`: rejected with its error when it refuses. */
function resolve(lookup: LookupFunction, hostname: string): Promise<void> {
  return new Promise((done, fail) => {
    lookup(hostname, { all: true }, err => {
      if (err === null) {
        done();
      } else {
        fail(err);
      }
    });
  });
}

/** A `request` whose every request `serve` answers, given its URL and options; a throw from
 *  `serve` fails the request as a refused connection would. */
export function fakeHttpsRequest(
  serve: (url: string, options: RequestOptions) => FakeResponse
): RequestFn {
  return (target, options, onResponse) => {
    const url = new URL(target);
    const request = new EventEmitter();
    const answer = async (): Promise<void> => {
      if (options.lookup !== undefined) {
        await resolve(options.lookup, url.hostname);
      }
      const { status = 200, headers = {}, body } = serve(url.href, options);
      onResponse?.(
        Object.assign(Readable.from([Buffer.from(body)]), {
          statusCode: status,
          headers
        }) as unknown as IncomingMessage
      );
    };
    return Object.assign(request, {
      end: () => {
        answer().catch((err: unknown) => request.emit('error', err));
        return request;
      }
    }) as unknown as ClientRequest;
  };
}
