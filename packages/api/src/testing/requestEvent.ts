/**
 * The `RequestEvent` a test hands a route handler, hook or remote function, and the in-memory
 * `event.cookies` it carries.
 */
import type { Cookies, RequestEvent } from '@sveltejs/kit';

type CookieOptions = Parameters<Cookies['set']>[2];

/** An in-memory `event.cookies` that keeps the options each cookie was set with, so one jar
 *  carries a cookie between two calls the way a browser does between two requests. */
export type CookieJar = Cookies & {
  written: Map<string, { value: string; options: CookieOptions }>;
};

export function cookieJar(): CookieJar {
  const written: CookieJar['written'] = new Map();
  return {
    written,
    get: name => written.get(name)?.value,
    getAll: () => [...written].map(([name, { value }]) => ({ name, value })),
    set: (name, value, options) => {
      written.set(name, { value, options });
    },
    delete: name => {
      written.delete(name);
    },
    parse: () => {
      throw new Error(
        'cookieJar: no handler under test parses a Set-Cookie header'
      );
    },
    serialize: (name, value) => `${name}=${value}`
  };
}

type EventInit = {
  /** The request's method, headers and body. */
  init?: RequestInit;
  locals?: App.Locals;
  cookies?: Cookies;
  clientAddress?: string;
};

/**
 * A `RequestEvent` for a request to `url`, typed as the event `E` the code under test takes (a
 * route's own `RequestEvent`, a `load`'s `ServerLoadEvent` …). The members no code under test
 * reads (`fetch`, `params`, `route`, `parent` …) stay unset, which is why the object is asserted
 * to the type.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- `E` is the event type the caller's handler declares; the one assertion to it lives here instead of at every call site
export function requestEvent<E extends RequestEvent = RequestEvent>(
  url: string | URL,
  {
    init,
    locals = { auth: null },
    cookies = cookieJar(),
    clientAddress = '198.51.100.1'
  }: EventInit = {}
): E {
  return {
    request: new Request(url, init),
    url: new URL(url),
    locals,
    cookies,
    getClientAddress: () => clientAddress
  } as E;
}

/** `requestEvent` for a JSON `POST` of `body`. */
export function jsonPost(
  url: string | URL,
  body: unknown,
  rest: Omit<EventInit, 'init'> = {}
): RequestEvent {
  return requestEvent(url, {
    ...rest,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  });
}
