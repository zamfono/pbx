/**
 * The MWI trigger of the internal API, `POST /internal/mwi/{mailbox}` (§3.1): `api` changed a
 * mailbox's messages, and the core refreshes its message-waiting state. `server.ts` mounts
 * `handleMwiRoute`.
 */
import type http from 'node:http';

import {
  HTTP_NO_CONTENT,
  isMwiMailbox,
  parseMwiMailbox,
  type Db,
  type MwiMailbox
} from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { refreshMwi } from '../calls/voicemailStore.js';

// The mailbox arrives as one path segment, percent-encoded or not (`user:<id>` and `user%3A<id>`
// name the same mailbox), so the segment is decoded before it is matched.
const MWI_ROUTE = /^\/internal\/mwi\/(?<segment>[^/]+)$/u;

/** The mailbox `pathname` names on the MWI route, `null` off it or for a malformed segment. */
function matchMwiRoute(pathname: string): MwiMailbox | null {
  const segment = MWI_ROUTE.exec(pathname)?.groups?.segment;
  if (segment === undefined) {
    return null;
  }
  try {
    const mailbox = decodeURIComponent(segment);
    // Interpolated into the ARI REST path `mailboxes/<name>` as it stands, so only the exact
    // shape `isMwiMailbox` admits is accepted.
    return isMwiMailbox(mailbox) ? mailbox : null;
  } catch {
    return null;
  }
}

async function serveMwi(
  deps: { db: Db; ari: AriClient },
  mailbox: MwiMailbox,
  response: http.ServerResponse
): Promise<void> {
  await refreshMwi(deps, parseMwiMailbox(mailbox));
  response.writeHead(HTTP_NO_CONTENT);
  response.end();
}

/** Serves the MWI trigger `POST`; `null` when `pathname` names no mailbox on its route. */
export function handleMwiRoute(
  deps: { db: Db; ari: AriClient },
  pathname: string,
  response: http.ServerResponse
): Promise<void> | null {
  const mailbox = matchMwiRoute(pathname);
  return mailbox === null ? null : serveMwi(deps, mailbox, response);
}
