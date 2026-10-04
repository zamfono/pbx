import * as env from '$app/env/private';

import { getDb } from '#lib/server/db.js';
import { problemFromError } from '#lib/server/problem.js';
import { formFields } from '#lib/server/restBody.js';
import { outputResponse } from '#lib/server/restTransport.js';
import { runUploadLink } from '#lib/server/uploadLink.js';

import type { RequestHandler } from './$types.js';

/**
 * `POST <upload link>` (§10.5 "Uploads"): the file, as multipart form data under the field
 * `upload`, runs the operation the link stands for and answers as its REST endpoint would. A
 * browser opening the link gets `+page.svelte` instead (SvelteKit content negotiation).
 */
export const POST: RequestHandler = async ({ request, url }) => {
  try {
    const output = await runUploadLink(
      { db: getDb(), jwtSecret: env.JWT_SECRET },
      url,
      async () => formFields(await request.formData())
    );
    const response = await outputResponse(output);
    // RFC 6750 §2.3: a response to a request whose token is in the URI is kept from shared caches.
    response.headers.set('cache-control', 'private');
    return response;
  } catch (error) {
    return problemFromError(error);
  }
};
