/**
 * Why a webhook delivery failed (§10.6 "Webhooks"), as one short reason a hook's failure is
 * logged and deduplicated on and `webhooks.list` shows: the HTTP status of a response that was
 * not 2xx or the class of error of a request that got none, both `@zamfono/shared`'s
 * (`httpSend.ts`), and a secret that cannot be decrypted.
 */
export { errorReason, httpReason } from '@zamfono/shared';

/** The reason of a delivery dropped because its hook's secret cannot be decrypted. */
export const SECRET_UNREADABLE = 'secret unreadable — set a new secret';
