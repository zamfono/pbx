import { z } from 'zod';

import { isIanaTimeZone } from '@zamfono/shared';

import { isCronExpression } from '#lib/server/jobs/cronExpression.js';

import { targetInputSchema } from '../dids/_shared.js';
import { CODECS } from '../trunks/_shared.js';
import {
  CALL_LOG_LEVELS,
  LANGUAGES,
  SMTP_SECURITIES,
  SSO_PROVIDERS
} from './_shared.js';

const MAX_SMTP_PORT = 65535;
const MAX_TLS_RELOAD_HOUR = 23;
const MIN_AUDIT_RETENTION_DAYS = 30;
const COUNTRY_CODE_LENGTH = 2;

/**
 * `PATCH /settings`'s body (§10.3, §11.4): every writable column under its wire name, each
 * described from the §11.4 table for the tool and OpenAPI schemas (§10.5). The fields
 * `OWNER_FIELDS` names say so, since an admin's write of one is refused with 403.
 */
export const settingsInputSchema = z
  .object({
    companyName: z.string().min(1).optional(),
    mainDidId: z
      .string()
      .optional()
      .describe(
        'The company main number, a live numeric DID, presented when neither route nor caller sets one; see zamfono.help numbers.'
      ),
    country: z
      .string()
      .length(COUNTRY_CODE_LENGTH)
      .optional()
      .describe(
        'ISO 3166-1 alpha-2 code, such as DE; its calling code turns a national number into the international form.'
      ),
    timezone: z
      .string()
      .refine(isIanaTimeZone, 'timezone must be an IANA time zone')
      .nullish()
      .describe(
        "IANA time zone, such as Europe/Berlin, for every hour-based feature; null: the stack's TZ, else UTC."
      ),
    language: z
      .enum(LANGUAGES)
      .optional()
      .describe(
        'The language of the prompts callers hear, the mails and the sign-in pages.'
      ),
    smtpHost: z
      .string()
      .min(1)
      .nullish()
      .describe('The mail relay host; null: no mail is sent. Owner-only.'),
    smtpPort: z
      .number()
      .int()
      .min(1)
      .max(MAX_SMTP_PORT)
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
      ),
    emergencyNumbers: z
      .array(z.string().regex(/^[0-9]+$/u))
      .min(1)
      .optional()
      .describe(
        'Digit strings always dialled out as emergency calls and never valid as extensions (see zamfono.help emergency-calls). Owner-only.'
      ),
    featureCodes: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Dialled prefixes for the ten keys pickup, dndOn, dndOff, mailbox, ownVoicemail, deposit, addParty, clirOn, clirOff and park, all sent together; each starts with * or # and none is a prefix of another.'
      ),
    fallbackTarget: targetInputSchema
      .nullable()
      .optional()
      .describe(
        'The tenant-wide fallback for a number in a block that no DID holds and for a number outside every DID and block; null: such calls are released with 404 (see zamfono.help numbers).'
      ),
    codecs: z
      .array(z.enum(CODECS))
      .min(1)
      .optional()
      .describe(
        'The ordered codec offer to devices and to trunks without their own list.'
      ),
    clir: z
      .boolean()
      .optional()
      .describe(
        'Tenant default for withholding the caller number on outbound calls; a trunk, a user and a #31#/*31# prefix override it.'
      ),
    rejectAnonymous: z
      .boolean()
      .optional()
      .describe(
        'Tenant default for refusing callers who withhold their number; a user overrides it.'
      ),
    holdMohAudioId: z
      .string()
      .nullish()
      .describe(
        'A moh audio asset played to parties on hold; null: the built-in default music (see zamfono.help music-licensing).'
      ),
    voicemailMaxS: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum length of one voicemail in seconds, 180 by default.'),
    parkingTimeoutS: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Seconds a parked call waits before ringing the parker back, 300 by default.'
      ),
    callLogLevel: z
      .enum(CALL_LOG_LEVELS)
      .optional()
      .describe(
        'Tenant default per-call diagnostics level, each adding to the previous: none, events (routing trace, the default), qos, sip (needs HEP_ENABLED); see zamfono.help diagnose-bad-call.'
      ),
    recordingRetentionDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Days recordings, call logs, QoS, presence log and backup runs are kept, 90 by default.'
      ),
    softDeleteRetentionDays: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Days a soft-deleted row survives before the hard purge, which bounds undoing a deletion; 30 by default.'
      ),
    auditRetentionDays: z
      .number()
      .int()
      .min(MIN_AUDIT_RETENTION_DAYS)
      .nullish()
      .describe(
        'Days audit entries are kept, at least 30; null: forever. Owner-only.'
      ),
    backupCron: z
      .string()
      .min(1)
      .refine(isCronExpression, 'backupCron must be a cron expression')
      .optional()
      .describe('Cron expression of the backup job, 0 3 * * * by default.'),
    tlsReloadHour: z
      .number()
      .int()
      .min(0)
      .max(MAX_TLS_RELOAD_HOUR)
      .nullish()
      .describe(
        'Hour 0-23 for swapping in a renewed certificate when no opening-hours schedule offers a closed period.'
      ),
    autoUpdate: z
      .boolean()
      .optional()
      .describe(
        'Install newer non-breaking releases automatically, after a backup, at a maintenance moment when no call is in progress; off by default. Owner-only.'
      ),
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
      .describe(
        'The OIDC client secret; write-only, masked on read. Owner-only.'
      ),
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
  })
  .strict();
