import nodemailer, { type Transporter } from 'nodemailer';

import type { Db, SmtpSecurity } from '@zamfono/shared';

import { decrypt, type Keyring } from '../secretbox.js';

export type RelayConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  password: string | null;
  from: string;
  fromName: string;
};

/** The tenant's mail relay (§11.4 `smtp_*`, `mail_from`), or `null` while `smtp_host` is unset. */
export async function relayFromSettings(
  db: Db,
  kr: Keyring
): Promise<RelayConfig | null> {
  const settings = await db
    .selectFrom('settings')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  // `mail_from` is seeded together with `smtp_host` at first boot (§6.3, §10.2 "Sender"); a NULL
  // `mail_from` or `smtp_host` means no relay is configured (§11.4).
  if (settings.smtpHost === null || settings.mailFrom === null) {
    return null;
  }
  return {
    host: settings.smtpHost,
    port: settings.smtpPort,
    security: settings.smtpSecurity,
    user: settings.smtpUser,
    password:
      settings.smtpPasswordEnc === null
        ? null
        : decrypt(
            kr,
            'settings.smtpPasswordEnc',
            settings.smtpPasswordEnc
          ).toString('utf8'),
    from: settings.mailFrom,
    fromName: settings.companyName
  };
}

/** The nodemailer transport for `relay`: implicit TLS or STARTTLS, authenticated when a user is set. */
export function createTransportFor(relay: RelayConfig): Transporter {
  return nodemailer.createTransport({
    host: relay.host,
    port: relay.port,
    secure: relay.security === 'tls',
    requireTLS: relay.security === 'starttls',
    auth:
      relay.user === null
        ? undefined
        : { user: relay.user, pass: relay.password ?? '' }
  });
}
