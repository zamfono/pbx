import { z } from 'zod';

import {
  CALL_LOG_LEVELS,
  codecsSchema,
  emergencyNumbersSchema,
  featureCodesSchema,
  isIanaTimeZone,
  isSupportedCountry,
  LANGUAGES,
  MAX_SIP_BAN_PERIOD_S,
  sipBanStepsSchema
} from '@zamfono/shared';

import { isCronExpression } from '#lib/server/jobs/cronExpression.js';

import { targetSpecSchema } from '../forwardTargetSchema.js';
import { timeoutSeconds } from '../timeoutInput.js';
import {
  mailInputFields,
  ringotelInputFields,
  ssoInputFields
} from './_inputIntegrations.js';

const MAX_TLS_RELOAD_HOUR = 23;
const MIN_AUDIT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 36_500;
const COUNTRY_CODE_LENGTH = 2;

/** A SIP ban period in whole seconds, at most 100 years (§11.4); each field sets its floor. */
const sipBanPeriodSeconds = z.number().int().max(MAX_SIP_BAN_PERIOD_S);

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
      .refine(
        isSupportedCountry,
        'country must be an ISO 3166-1 alpha-2 code with a calling code'
      )
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
    ...mailInputFields,
    emergencyNumbers: emergencyNumbersSchema
      .optional()
      .describe(
        'Digit strings always dialled out as emergency calls and never valid as extensions (see zamfono.help emergency-calls). Owner-only.'
      ),
    featureCodes: featureCodesSchema
      .optional()
      .describe(
        'Dialled prefixes for the ten keys pickup, dndOn, dndOff, mailbox, ownVoicemail, deposit, addParty, clirOn, clirOff and park, all sent together; each starts with * or # and none is a prefix of another.'
      ),
    fallbackTarget: targetSpecSchema
      .nullable()
      .optional()
      .describe(
        'The tenant-wide fallback for a number in a block that no DID holds and for a number outside every DID and block; null: such calls are released with 404 (see zamfono.help numbers).'
      ),
    codecs: codecsSchema
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
    voicemailMaxS: timeoutSeconds
      .optional()
      .describe('Maximum length of one voicemail in seconds, 180 by default.'),
    parkingTimeoutS: timeoutSeconds
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
      .max(MAX_RETENTION_DAYS)
      .nullish()
      .describe(
        'Days recordings, call logs, QoS, presence log and backup runs are kept, at most 36500, 90 by default; null: forever.'
      ),
    softDeleteRetentionDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_RETENTION_DAYS)
      .nullish()
      .describe(
        'Days a soft-deleted row survives before the hard purge, which bounds undoing a deletion; at most 36500, 30 by default; null: forever.'
      ),
    auditRetentionDays: z
      .number()
      .int()
      .min(MIN_AUDIT_RETENTION_DAYS)
      .max(MAX_RETENTION_DAYS)
      .nullish()
      .describe(
        'Days audit entries are kept, at least 30 and at most 36500; null: forever. Owner-only.'
      ),
    sipBanFailures: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Failed SIP attempts from one source address within sipBanWindowS that ban it, 10 by default.'
      ),
    sipBanWindowS: sipBanPeriodSeconds
      .min(1)
      .optional()
      .describe(
        "Seconds over which an address's failed SIP attempts are counted, 3600 by default."
      ),
    sipBanSuccessExemptS: sipBanPeriodSeconds
      .min(0)
      .optional()
      .describe(
        'Seconds after a successful SIP authentication during which its address is never banned, 86400 by default; 0: no exemption.'
      ),
    sipBanLookbackS: sipBanPeriodSeconds
      .min(1)
      .optional()
      .describe(
        "Seconds after a ban ended within which the address's next ban takes the next step, and after which the ended ban is deleted; 2592000 (30 days) by default."
      ),
    sipBanSteps: sipBanStepsSchema
      .optional()
      .describe(
        "Ban lengths in seconds for an address's first, second, … consecutive ban, each 60 to 3153600000 and longer than the one before, null (permanent) only as the last; [] switches banning off; [86400,31536000,null] by default. Applies to new bans only."
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
    ...ssoInputFields,
    ...ringotelInputFields
  })
  .strict();

/** A `PATCH /settings` body as `settingsInputSchema` parses it. */
export type SettingsInput = z.infer<typeof settingsInputSchema>;
