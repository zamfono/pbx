import type { RequestEvent } from '@sveltejs/kit';

import { getCertSyncScheduler } from '#lib/server/jobs/certSync.js';

const STATUS_NOT_FOUND = 404;
const STATUS_ACCEPTED = 202;

/**
 * `POST /internal/certificate` (§3.1, §6.4 "TLS certificates"): the `proxy` image's
 * `cert_obtained` hook (images/proxy/zamfono-cert-hook) posts here, with an empty body, right
 * after it copies a new certificate onto `caddy-data`. `api` responds by running the same
 * compare-and-schedule pass its hourly poll and its own start already run (`certSync.ts`), which
 * keeps §6.4's reload-timing rules — a notification only makes that pass run sooner, it never
 * skips them.
 *
 * Reachable from the internal network only, exactly like `/internal/mail` (§3.1 "Mail"): Caddy
 * answers 404 for the whole `/internal` prefix (deploy/Caddyfile), so a request carrying
 * `X-Forwarded-For` came through the proxy hop instead and is refused the same way. The hook
 * itself reaches `api` directly — the `proxy` container shares Asterisk's network namespace
 * (network_mode: service:asterisk, §6.3) and is on the `internal` network `api` is too — without
 * a proxy hop, so a real notification never carries that header.
 *
 * A failed or missed notification is not fatal (§6.4: hourly poll plus the sync at `api` start
 * are the fallback), so this never inspects the body or reports anything but 202/404.
 */
export function POST(event: RequestEvent): Response {
  if (event.request.headers.has('x-forwarded-for')) {
    return new Response(null, { status: STATUS_NOT_FOUND });
  }
  getCertSyncScheduler().notify();
  return new Response(null, { status: STATUS_ACCEPTED });
}
