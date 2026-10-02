import { notifyCertSync } from '#lib/server/jobs/certSync.js';

const STATUS_ACCEPTED = 202;

/**
 * `POST /internal/certificate` (§3.1, §6.4 "TLS certificates"): the `proxy` image's
 * `cert_obtained` hook (images/proxy/zamfono-cert-hook) posts here, with an empty body, right
 * after it copies a new certificate onto `caddy-data`. `api` responds by running the same
 * compare-and-schedule pass its hourly poll and its own start already run (`certSync.ts`), which
 * keeps §6.4's reload-timing rules — a notification only makes that pass run sooner, it never
 * skips them.
 *
 * The hook reaches `api` directly: the `proxy` container shares Asterisk's network namespace
 * (network_mode: service:asterisk, §6.3) and is on the `internal` network `api` is too, with no
 * proxy hop, so `hooks.server.ts` lets it through.
 *
 * A failed or missed notification is not fatal (§6.4: hourly poll plus the sync at `api` start
 * are the fallback), so this never inspects the body or reports anything but 202.
 */
export function POST(): Response {
  notifyCertSync();
  return new Response(null, { status: STATUS_ACCEPTED });
}
