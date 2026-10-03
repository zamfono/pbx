/**
 * The ARI client's HTTP side (§3, §9.2): Basic auth for both the REST calls and the events
 * WebSocket, REST URLs under the configured base, and the one `fetch` wrapper every REST call goes
 * through, which turns a non-2xx answer into an `AriError`.
 */
import { AriError, parseErrorBody } from './types.js';

/** Where Asterisk's ARI listens and the ARI user to authenticate as. */
type AriCredentials = {
  url: string;
  user: string;
  password: string;
};

/** The two shapes of ARI REST call: one whose JSON answer is read, and one whose answer is not. */
export type AriRequests = {
  json: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  void: (method: string, path: string, body?: unknown) => Promise<void>;
};

/** The Basic `Authorization` header, for the REST calls and the events WebSocket alike. */
export function authHeaders(
  credentials: AriCredentials
): Record<string, string> {
  const token = Buffer.from(
    `${credentials.user}:${credentials.password}`
  ).toString('base64');
  return { Authorization: `Basic ${token}` };
}

/** `path` resolved under the configured ARI base URL, whichever slashes either side carries. */
function buildRestUrl(credentials: AriCredentials, path: string): URL {
  return new URL(
    path.replace(/^\/+/u, ''),
    `${credentials.url.replace(/\/$/u, '')}/`
  );
}

async function fetchAri(
  credentials: AriCredentials,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const response = await fetch(buildRestUrl(credentials, path), {
    method,
    headers: {
      ...authHeaders(credentials),
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    throw new AriError(response.status, await parseErrorBody(response));
  }
  return response;
}

/** The REST calls against `credentials`' ARI, as standalone functions the namespaces close over. */
export function ariRequests(credentials: AriCredentials): AriRequests {
  return {
    json: async <T>(
      method: string,
      path: string,
      body?: unknown
    ): Promise<T> => {
      const response = await fetchAri(credentials, method, path, body);
      return (await response.json()) as T;
    },
    void: async (method, path, body) => {
      await fetchAri(credentials, method, path, body);
    }
  };
}
