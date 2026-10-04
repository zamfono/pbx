import type { Selectable, Updateable } from 'kysely';
import { z } from 'zod';

import {
  CALL_LOG_LEVELS,
  codecsColumn,
  codecsSchema,
  emergencyNumbersColumn,
  emergencyNumbersSchema,
  featureCodesColumn,
  featureCodesSchema,
  HTTP_FORBIDDEN,
  LANGUAGES,
  SMTP_SECURITIES,
  SSO_PROVIDERS,
  type Db,
  type DB,
  type UserRole
} from '@zamfono/shared';

import { targetSpecSchema } from '../forwardTargetSchema.js';
import { resolveOptionalTarget } from '../forwardTargetSpec.js';
import { OpError } from '../types.js';
import type { SettingsInput } from './_input.js';

export type SettingsRow = Selectable<DB['settings']>;
/** The `settings` columns one `PATCH /settings` writes. */
export type SettingsColumns = Updateable<DB['settings']>;

/**
 * The wire shape of the tenant `settings` row (§11.4): every column, the read-only `extLength`,
 * `ringotelOrgId` and `ringotelBranchId` included, except the `*_pending` state columns. A 🔒
 * secret is never returned: its read-only `<name>Set` says whether one is stored (§10.3).
 */
export const settingsWire = z.object({
  companyName: z.string(),
  mainDidId: z.string(),
  country: z.string(),
  timezone: z.string().nullable(),
  language: z.enum(LANGUAGES),
  smtpHost: z.string().nullable(),
  smtpPort: z.number(),
  smtpSecurity: z.enum(SMTP_SECURITIES),
  smtpUser: z.string().nullable(),
  smtpPasswordSet: z.boolean(),
  mailFrom: z.string().nullable(),
  extLength: z.number(),
  emergencyNumbers: emergencyNumbersSchema,
  featureCodes: featureCodesSchema,
  fallbackTarget: targetSpecSchema.nullable(),
  codecs: codecsSchema,
  clir: z.boolean(),
  rejectAnonymous: z.boolean(),
  holdMohAudioId: z.string().nullable(),
  voicemailMaxS: z.number(),
  parkingTimeoutS: z.number(),
  callLogLevel: z.enum(CALL_LOG_LEVELS),
  recordingRetentionDays: z.number(),
  softDeleteRetentionDays: z.number(),
  auditRetentionDays: z.number().nullable(),
  backupCron: z.string(),
  tlsReloadHour: z.number().nullable(),
  autoUpdate: z.boolean(),
  ssoProvider: z.enum(SSO_PROVIDERS).nullable(),
  ssoLabel: z.string().nullable(),
  ssoIssuer: z.string().nullable(),
  ssoClientId: z.string().nullable(),
  ssoTenantId: z.string().nullable(),
  ssoAllowedDomain: z.string().nullable(),
  ssoClientSecretSet: z.boolean(),
  ringotelOrgId: z.string().nullable(),
  ringotelBranchId: z.string().nullable(),
  ringotelMaxRegs: z.number(),
  ringotelApiTokenSet: z.boolean()
});
export type SettingsWire = z.infer<typeof settingsWire>;

/** Fields only an owner may write (👑, §11.4); every other writable field is admin's. */
export const OWNER_FIELDS: ReadonlySet<keyof SettingsInput> = new Set([
  'smtpHost',
  'smtpPort',
  'smtpSecurity',
  'smtpUser',
  'smtpPassword',
  'mailFrom',
  'emergencyNumbers',
  'auditRetentionDays',
  'autoUpdate',
  'ssoProvider',
  'ssoLabel',
  'ssoIssuer',
  'ssoClientId',
  'ssoTenantId',
  'ssoAllowedDomain',
  'ssoClientSecret',
  'ringotelMaxRegs',
  'ringotelApiToken'
]);

/** Throws 403 when `role` may not write `field` (owner-only fields, §11.4). */
export function checkFieldRole(
  field: keyof SettingsInput,
  role: UserRole
): void {
  if (OWNER_FIELDS.has(field) && role !== 'owner') {
    throw new OpError(HTTP_FORBIDDEN, `settings: '${field}' is owner-only`);
  }
}

/** Loads the `settings` singleton row (`id = 1`, §11.1). */
export function loadSettings(db: Db): Promise<SettingsRow> {
  return db
    .selectFrom('settings')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
}

/** Maps a `settings` row to its wire shape, each 🔒 secret as its `<name>Set` (§10.3, §11.4). */
export async function rowToWire(
  db: Db,
  row: SettingsRow
): Promise<SettingsWire> {
  return {
    companyName: row.companyName,
    mainDidId: row.mainDidId,
    country: row.country,
    timezone: row.timezone,
    language: row.language,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecurity: row.smtpSecurity,
    smtpUser: row.smtpUser,
    smtpPasswordSet: row.smtpPasswordEnc !== null,
    mailFrom: row.mailFrom,
    extLength: row.extLength,
    emergencyNumbers: emergencyNumbersColumn.decode(row.emergencyNumbersJson),
    featureCodes: featureCodesColumn.decode(row.featureCodesJson),
    fallbackTarget: await resolveOptionalTarget(db, row.fallbackTargetId),
    codecs: codecsColumn.decode(row.codecsJson),
    clir: row.clir === 1,
    rejectAnonymous: row.rejectAnonymous === 1,
    holdMohAudioId: row.holdMohAudioId,
    voicemailMaxS: row.voicemailMaxS,
    parkingTimeoutS: row.parkingTimeoutS,
    callLogLevel: row.callLogLevel,
    recordingRetentionDays: row.recordingRetentionDays,
    softDeleteRetentionDays: row.softDeleteRetentionDays,
    auditRetentionDays: row.auditRetentionDays,
    backupCron: row.backupCron,
    tlsReloadHour: row.tlsReloadHour,
    autoUpdate: row.autoUpdate === 1,
    ssoProvider: row.ssoProvider,
    ssoLabel: row.ssoLabel,
    ssoIssuer: row.ssoIssuer,
    ssoClientId: row.ssoClientId,
    ssoTenantId: row.ssoTenantId,
    ssoAllowedDomain: row.ssoAllowedDomain,
    ssoClientSecretSet: row.ssoClientSecretEnc !== null,
    ringotelOrgId: row.ringotelOrgId,
    ringotelBranchId: row.ringotelBranchId,
    ringotelMaxRegs: row.ringotelMaxRegs,
    ringotelApiTokenSet: row.ringotelApiTokenEnc !== null
  };
}
