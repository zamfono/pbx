import type { Selectable, Updateable } from 'kysely';

import {
  codecsColumn,
  emergencyNumbersColumn,
  featureCodesColumn,
  HTTP_FORBIDDEN,
  type CallLogLevel,
  type Codec,
  type CountryCode,
  type Db,
  type DB,
  type FeatureCodes,
  type Language,
  type SmtpSecurity,
  type SsoProvider,
  type UserRole
} from '@zamfono/shared';

import { type TargetSpec } from '../forwardTargetSchema.js';
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
export type SettingsWire = {
  companyName: string;
  mainDidId: string;
  country: CountryCode;
  timezone: string | null;
  language: Language;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUser: string | null;
  smtpPasswordSet: boolean;
  mailFrom: string | null;
  extLength: number;
  emergencyNumbers: string[];
  featureCodes: FeatureCodes;
  fallbackTarget: TargetSpec | null;
  codecs: Codec[];
  clir: boolean;
  rejectAnonymous: boolean;
  holdMohAudioId: string | null;
  voicemailMaxS: number;
  parkingTimeoutS: number;
  callLogLevel: CallLogLevel;
  recordingRetentionDays: number;
  softDeleteRetentionDays: number;
  auditRetentionDays: number | null;
  backupCron: string;
  tlsReloadHour: number | null;
  autoUpdate: boolean;
  ssoProvider: SsoProvider | null;
  ssoLabel: string | null;
  ssoIssuer: string | null;
  ssoClientId: string | null;
  ssoTenantId: string | null;
  ssoAllowedDomain: string | null;
  ssoClientSecretSet: boolean;
  ringotelOrgId: string | null;
  ringotelBranchId: string | null;
  ringotelMaxRegs: number;
  ringotelApiTokenSet: boolean;
};

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
