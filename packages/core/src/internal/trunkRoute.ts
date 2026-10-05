/**
 * The trunk action of the internal API, `POST /internal/trunks/{id}/reregister` (§3, §9.4
 * "Provisioning and status"): `api`'s `trunks.reregister` has the trunk register afresh.
 * `server.ts` mounts `handleTrunkRoute`.
 */
import type http from 'node:http';

import { HTTP_NO_CONTENT } from '@zamfono/shared';

import { ActionError } from '../calls/actionError.js';
import type { TrunkState } from '../calls/trunkState.js';
import { respondProblem } from './http.js';

/** `trunkState.ts`'s `TrunkState`, as far as this route needs it. */
export type TrunkReregister = Pick<TrunkState, 'reregister'>;

const REREGISTER_ROUTE = /^\/internal\/trunks\/(?<trunkId>[^/]+)\/reregister$/u;

async function serveReregister(
  trunks: TrunkReregister,
  trunkId: string,
  response: http.ServerResponse
): Promise<void> {
  try {
    await trunks.reregister(trunkId);
  } catch (error) {
    if (!(error instanceof ActionError)) {
      throw error;
    }
    respondProblem(response, error.status, error.message, error.reason);
    return;
  }
  response.writeHead(HTTP_NO_CONTENT);
  response.end();
}

/** Serves the re-registration `POST`; `null` when `pathname` names no trunk on its route. */
export function handleTrunkRoute(
  { trunks }: { trunks: TrunkReregister },
  pathname: string,
  response: http.ServerResponse
): Promise<void> | null {
  const trunkId = REREGISTER_ROUTE.exec(pathname)?.groups?.trunkId;
  return trunkId === undefined
    ? null
    : serveReregister(trunks, trunkId, response);
}
