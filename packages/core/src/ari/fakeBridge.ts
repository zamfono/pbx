// FakeAri's bridge model: create/list/destroy and channel membership, a module of its own to keep
// fake.ts under the file size limit.
import { randomUUID } from 'node:crypto';

import { splitResource, type RouteResult } from './fakeHttp.js';

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

export type Bridge = { id: string; channels: string[] };

function routeBridgeAction(
  method: string,
  action: string,
  bridge: Bridge,
  body: unknown
): RouteResult {
  if (action === '' && method === 'DELETE') {
    return { status: HTTP_OK, body: {} };
  }
  if (action === 'addChannel' && method === 'POST') {
    const params = body as { channel?: string };
    if (params.channel !== undefined) {
      bridge.channels.push(params.channel);
    }
    return { status: HTTP_OK, body: {} };
  }
  if (action === 'removeChannel' && method === 'POST') {
    const params = body as { channel?: string };
    bridge.channels = bridge.channels.filter(
      channelId => channelId !== params.channel
    );
    return { status: HTTP_OK, body: {} };
  }
  if (action === 'play' && method === 'POST') {
    return { status: HTTP_OK, body: { id: randomUUID() } };
  }
  return { status: HTTP_OK, body: {} };
}

// ponytail: bridge moh falls through to the 200 {} ack above; add state if a test needs it.
/** Routes every `bridges`/`bridges/*` request against `bridges`, mutating it in place (a `DELETE`
 * on the bridge itself is applied by the caller, which owns the map). */
export function routeBridge(
  bridges: Map<string, Bridge>,
  method: string,
  path: string,
  body: unknown
): RouteResult {
  if (path === 'bridges' && method === 'POST') {
    const params = body as { bridgeId?: string };
    const bridge: Bridge = {
      id: params.bridgeId ?? randomUUID(),
      channels: []
    };
    bridges.set(bridge.id, bridge);
    return { status: HTTP_OK, body: { id: bridge.id } };
  }
  if (path === 'bridges' && method === 'GET') {
    return { status: HTTP_OK, body: [...bridges.values()] };
  }
  const { id, action } = splitResource(path, 'bridges/');
  const bridge = bridges.get(id);
  if (!bridge) {
    return { status: HTTP_NOT_FOUND, body: { message: 'Bridge not found' } };
  }
  if (action === '' && method === 'DELETE') {
    bridges.delete(id);
  }
  return routeBridgeAction(method, action, bridge, body);
}
