import * as env from '$app/env/private';

import { getDb } from '#lib/server/db.js';
import { uploadLinkAuth } from '#lib/server/uploadLink.js';

import type { PageServerLoad } from './$types.js';

/**
 * An upload link opened in a browser (§10.5 "Uploads"): the file picker for a link that still
 * opens, else the page's expired-link message rather than a form whose submission can only fail.
 */
export const load: PageServerLoad = async ({ url, setHeaders }) => {
  // RFC 6750 §2.3: a response to a request whose token is in the URI is kept from shared caches.
  setHeaders({ 'cache-control': 'private' });
  const auth = await uploadLinkAuth(
    { db: getDb(), jwtSecret: env.JWT_SECRET },
    url
  );
  return { live: auth !== null };
};
