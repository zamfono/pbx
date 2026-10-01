/**
 * The MWI trigger of the internal API, `POST /internal/mwi/{mailbox}` (§3.1): `api` changed a
 * mailbox's messages, and the core refreshes its message-waiting state. `server.ts` mounts
 * `handleMwiRoute`.
 */
import type http from 'node:http';

import { parseMwiMailbox, type Db, type MwiMailbox } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { refreshMwi } from '../calls/voicemailStore.js';

const HTTP_NO_CONTENT = 204;
// The mailbox arrives as one path segment, percent-encoded or not (`user:<id>` and `user%3A<id>`
// name the same mailbox), so the segment is decoded before it is matched.
const MWI_ROUTE = /^\/internal\/mwi\/(?<segment>[^/]+)$/u;
// The owner part is an entity id, a UUID (§11.1), and the decoded name is interpolated into the
// ARI REST path `mailboxes/<name>` as it stands, so only that exact shape is accepted.
const MWI_MAILBOX =
  /^(?:user|ringGroup):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The mailbox `pathname` names on the MWI route, `null` off it or for a malformed segment. */
function matchMwiRoute(pathname: string): MwiMailbox | null {
  const segment = MWI_ROUTE.exec(pathname)?.groups?.segment;
  if (segment === undefined) {
    return null;
  }
  try {
    const mailbox = decodeURIComponent(segment);
    return MWI_MAILBOX.test(mailbox) ? (mailbox as MwiMailbox) : null;
  } catch {
    return null;
  }
}

/** Serves the MWI trigger `POST`; `false` when `pathname` names no mailbox on its route. */
export async function handleMwiRoute(
  deps: { db: Db; ari: AriClient },
  pathname: string,
  response: http.ServerResponse
): Promise<boolean> {
  const mailbox = matchMwiRoute(pathname);
  if (mailbox === null) {
    return false;
  }
  await refreshMwi(deps, parseMwiMailbox(mailbox));
  response.writeHead(HTTP_NO_CONTENT);
  response.end();
  return true;
}
