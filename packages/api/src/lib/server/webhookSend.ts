/**
 * One send of an event to its webhook (§10.6 "Webhooks"): a POST of the outbox row's body as
 * JSON, signed with the hook's current secret and carrying its custom headers.
 */
import type { Db, HttpSend } from '@zamfono/shared';

import { attempt } from './errors.js';
import { readHeaders } from './ops/httpHeaders.js';
import { decrypt, type Keyring } from './secretbox.js';
import { SECRET_UNREADABLE } from './webhookFailure.js';

/** What a delivery attempt sends: the request but for what the dispatcher adds, why no attempt
 * could send it, or `null` when the delivery's owner is gone, which ends it with no status. */
export type DeliverySend =
  { send: Omit<HttpSend, 'timeoutMs' | 'policy'> } | { failure: string } | null;

/**
 * The POST of delivery `row` to its hook; `null` when the delivery is gone or its hook deleted
 * or switched off. A secret or secret header that cannot be decrypted (§5.4: a key replaced
 * without its previous generation, a database restored under another `.env`) fails it for good.
 */
export async function webhookSend(
  deps: { db: Db; kr: Keyring },
  row: { id: string; bodyJson: string }
): Promise<DeliverySend> {
  const hook = await deps.db
    .selectFrom('webhookDeliveries')
    .innerJoin('webhooks', 'webhooks.id', 'webhookDeliveries.webhookId')
    .select([
      'webhooks.url',
      'webhooks.secretEnc',
      'webhooks.headersJson',
      'webhooks.secretHeadersEnc'
    ])
    .where('webhookDeliveries.id', '=', row.id)
    .where('webhooks.active', '=', 1)
    .where('webhooks.deletedAt', 'is', null)
    .executeTakeFirst();
  if (hook === undefined) {
    return null;
  }
  // The secret and the secret headers alike: neither can be read under another key.
  const credentials = attempt(() => ({
    secret: decrypt(deps.kr, 'webhooks.secretEnc', hook.secretEnc).toString(
      'utf8'
    ),
    headers: readHeaders(deps.kr, 'webhooks.secretHeadersEnc', hook)
  }));
  if (credentials === undefined) {
    return { failure: SECRET_UNREADABLE };
  }
  return {
    send: {
      method: 'POST',
      url: hook.url,
      headers: Object.fromEntries(
        credentials.headers.map(header => [header.name, header.value])
      ),
      body: row.bodyJson,
      contentType: 'application/json',
      secret: credentials.secret
    }
  };
}
