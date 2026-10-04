import { z } from 'zod';

import { MAX_PORT, SMTP_SECURITIES, SSO_PROVIDERS } from '@zamfono/shared';

/** The mail relay fields of `PATCH /settings` (§10.2, §11.4). */
export const mailInputFields = {
  smtpHost: z
    .string()
    .min(1)
    .nullish()
    .describe('The mail relay host; null: no mail is sent. Owner-only.'),
  smtpPort: z
    .number()
    .int()
    .min(1)
    .max(MAX_PORT)
    .optional()
    .describe('The mail relay port, 465 by default. Owner-only.'),
  smtpSecurity: z
    .enum(SMTP_SECURITIES)
    .optional()
    .describe(
      'tls (default) for implicit TLS, starttls to upgrade a plain connection. Owner-only.'
    ),
  smtpUser: z.string().nullish().describe('The mail relay user. Owner-only.'),
  smtpPassword: z
    .string()
    .nullish()
    .describe(
      'The mail relay password; write-only, masked on read. Owner-only.'
    ),
  mailFrom: z
    .string()
    .nullish()
    .describe(
      'Sender address of every mail; the relay must be allowed to send for its domain; null: no mail. Owner-only.'
    )
};

/** The single sign-on fields of `PATCH /settings` (§5.2, §11.4). */
export const ssoInputFields = {
  ssoProvider: z
    .enum(SSO_PROVIDERS)
    .nullish()
    .describe(
      'Single sign-on provider: microsoft, google or a generic oidc; null: local passwords only. Owner-only.'
    ),
  ssoLabel: z
    .string()
    .nullish()
    .describe('Sign-in button text, required for oidc. Owner-only.'),
  ssoIssuer: z
    .string()
    .nullish()
    .describe(
      'The OIDC issuer URL, required for oidc and preset for microsoft and google. Owner-only.'
    ),
  ssoClientId: z
    .string()
    .nullish()
    .describe(
      'The OIDC client id, required whenever a provider is set. Owner-only.'
    ),
  ssoTenantId: z
    .string()
    .nullish()
    .describe(
      "The customer's Entra tenant id, required for microsoft, so no other tenant's tokens are accepted. Owner-only."
    ),
  ssoAllowedDomain: z
    .string()
    .nullish()
    .describe('Only accounts of this mail domain may sign in. Owner-only.'),
  ssoClientSecret: z
    .string()
    .nullish()
    .describe('The OIDC client secret; write-only, masked on read. Owner-only.')
};

/** The Ringotel fields of `PATCH /settings` (§10.4, §11.4). */
export const ringotelInputFields = {
  ringotelMaxRegs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Registrations per Ringotel user, 3 by default; Ringotel setup sets the package value. Owner-only.'
    ),
  ringotelApiToken: z
    .string()
    .nullish()
    .describe(
      'The Ringotel Admin API bearer token; write-only, masked on read. Owner-only.'
    )
};
