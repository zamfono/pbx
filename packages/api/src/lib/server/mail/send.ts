import { setTimeout as sleep } from 'node:timers/promises';
import * as env from '$app/env/private';
import type { Transporter } from 'nodemailer';
import pino from 'pino';

import type { Db, MailRequest } from '@zamfono/shared';

import { voicemailAttachment } from '../audio/transcode.js';
import type { Keyring } from '../secretbox.js';
import { stackDomain } from '../stackAddress.js';
import { tenantTimeZone } from '../tenantTimeZone.js';
import { resolveRecipients } from './recipients.js';
import { createTransportFor, relayFromSettings } from './relay.js';
import { resolveTemplate } from './render.js';
import type { Language } from './templates.js';

const logger = pino({ name: 'mail' });

// §10.2 "Mail" ("Failure"): three retries in process, 30 s / 60 s / 120 s apart, then a logged
// warning and no further attempt — there is no persistent mail queue.
const FIRST_RETRY_DELAY_MS = 30_000;
const SECOND_RETRY_DELAY_MS = 60_000;
const THIRD_RETRY_DELAY_MS = 120_000;
const RETRY_BACKOFF_MS = [
  FIRST_RETRY_DELAY_MS,
  SECOND_RETRY_DELAY_MS,
  THIRD_RETRY_DELAY_MS
];
const DEFAULT_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

type Attachment = { filename: string; content: Buffer; contentType: string };

/**
 * The attachments of `req`: the `voicemail` kind's audio as the compressed transcode §10.2
 * "Attachments" requires, and nothing for the other kinds. A failed transcode leaves the mail
 * without audio, since the notification is worth more than the recording it would carry.
 */
async function attachmentsFor(req: {
  attachmentPath?: string;
  callId?: string;
}): Promise<Attachment[] | undefined> {
  if (req.attachmentPath === undefined) {
    return undefined;
  }
  try {
    const attachment = await voicemailAttachment(req.attachmentPath);
    return [
      {
        filename: attachment.filename,
        content: attachment.bytes,
        contentType: attachment.contentType
      }
    ];
  } catch (error) {
    logger.warn(
      { err: error, callId: req.callId },
      'mail: voicemail transcode failed, sending without audio'
    );
    return undefined;
  }
}

export type SetupOrResetRequest = {
  kind: 'reset' | 'setup';
  to: { userId: string };
  values: { link: string; linkExpiresAt: string; invitedBy?: string };
};

/** The mails `api` sends each owner about updates (§6.3 "Updates", §10.2 "Mail"). */
export type UpdateMailRequest =
  | {
      kind: 'updateFailed';
      to: { userId: string };
      values: {
        fromVersion: string;
        toVersion: string;
        reason: string;
        failedAt: string;
      };
    }
  | {
      kind: 'breakingUpdate';
      to: { userId: string };
      values: {
        currentVersion: string;
        version: string;
        releaseUrl: string;
        publishedAt: string;
      };
    };

/** Every mail `sendMail` renders: the core's, the account mails and the update mails. */
export type AnyMailRequest =
  MailRequest | SetupOrResetRequest | UpdateMailRequest;

/** The call a mail is about (§7), `undefined` for any other mail or a template test. */
function callIdOf(req: AnyMailRequest): string | undefined {
  return 'callId' in req ? req.callId : undefined;
}

/**
 * Renders `req`'s template and sends it over the tenant relay (§3.1 "Mail", §10.2 "Mail"),
 * retrying in process on failure. Returns `'skipped'` while no relay is configured or the
 * mailbox has no live recipient, `'sent'` once the relay accepts the message, `'failed'` after
 * the last retry.
 */
export async function sendMail(
  db: Db,
  kr: Keyring,
  req: AnyMailRequest,
  opts?: { attempts?: number; transport?: Transporter }
): Promise<'failed' | 'sent' | 'skipped'> {
  const relay = await relayFromSettings(db, kr);
  if (relay === null) {
    return 'skipped';
  }
  const recipients = await resolveRecipients(db, req.to);
  if (recipients.emails.length === 0) {
    return 'skipped';
  }
  const settings = await db
    .selectFrom('settings')
    .select(['companyName', 'language', 'timezone'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  const language = settings.language as Language;
  const template = await resolveTemplate(db, req.kind, language);
  const values = {
    ...req.values,
    companyName: settings.companyName,
    recipientName: recipients.name,
    fqdn: stackDomain(env) ?? ''
  };
  const rendered = template.render(values, {
    language,
    timezone: tenantTimeZone(settings.timezone)
  });
  const transport = opts?.transport ?? createTransportFor(relay);
  const attempts = opts?.attempts ?? DEFAULT_ATTEMPTS;
  const attachments = await attachmentsFor(
    req as { attachmentPath?: string; callId?: string }
  );
  // The structured form lets nodemailer encode the display name, so a `company_name` (§11.4,
  // owner-editable) containing a quote or comma cannot produce a malformed From header.
  const from = relay.fromName
    ? { name: relay.fromName, address: relay.from }
    : relay.from;
  // A ring-group mailbox mails every member (§10.2 "Mail"); `bcc` keeps their addresses from
  // each other, while a single recipient still gets an ordinary `to`.
  const envelope =
    recipients.emails.length > 1
      ? { to: from, bcc: recipients.emails }
      : { to: recipients.emails[0] };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each attempt must see the previous one's outcome before retrying
      await transport.sendMail({
        from,
        ...envelope,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html ?? undefined,
        attachments
      });
      return 'sent';
    } catch (error) {
      if (attempt === attempts) {
        // §7: a mail about a call is a call-related line, so it carries the call's id.
        logger.warn(
          { err: error, kind: req.kind, callId: callIdOf(req) },
          'mail: send failed, giving up'
        );
        return 'failed';
      }
      // eslint-disable-next-line no-await-in-loop -- the backoff before the next attempt is the point of the loop
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? THIRD_RETRY_DELAY_MS);
    }
  }
  return 'failed';
}
