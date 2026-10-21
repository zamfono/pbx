import { getDb } from '#lib/server/db.js';
import { provisioningFile } from '#lib/server/provisioning/link.js';

import type { RequestHandler } from './$types.js';

/** `GET /provision/<token>/<file>` (§10.4 "Provisioning link"): the token is the only authentication. */
export const GET: RequestHandler = async ({ params, getClientAddress }) => {
  const body = await provisioningFile(
    getDb(),
    params.token,
    params.file,
    getClientAddress()
  );
  if (body === null) {
    return new Response(null, { status: 404 });
  }
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // The body carries the SIP and admin passwords.
      'cache-control': 'no-store'
    }
  });
};
