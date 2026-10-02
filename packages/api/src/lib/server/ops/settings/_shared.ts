import type { Selectable } from 'kysely';

import type { Db, DB, FeatureCodes } from '@zamfono/shared';

import { resolveOptionalTarget, type TargetInput } from '../dids/_shared.js';
import type { Codec } from '../trunks/_shared.js';
import { OpError, type Role } from '../types.js';

export type SettingsRow = Selectable<DB['settings']>;

const STATUS_FORBIDDEN = 403;

export const LANGUAGES = ['de', 'en', 'es', 'fr', 'it', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

export const SMTP_SECURITIES = ['tls', 'starttls'] as const;
export const CALL_LOG_LEVELS = ['none', 'events', 'qos', 'sip'] as const;
export const SSO_PROVIDERS = ['microsoft', 'google', 'oidc'] as const;

const MASKED = '***';

/** The wire shape of the tenant `settings` row (§11.4), every column but the three read-only ones. */
export type SettingsWire = {
  companyName: string;
  mainDidId: string;
  country: string;
  timezone: string | null;
  language: Language;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecurity: (typeof SMTP_SECURITIES)[number];
  smtpUser: string | null;
  smtpPassword: string | null;
  mailFrom: string | null;
  extLength: number;
  emergencyNumbers: string[];
  featureCodes: FeatureCodes;
  fallbackTarget: TargetInput | null;
  codecs: Codec[];
  clir: boolean;
  rejectAnonymous: boolean;
  holdMohAudioId: string | null;
  voicemailMaxS: number;
  parkingTimeoutS: number;
  callLogLevel: (typeof CALL_LOG_LEVELS)[number];
  recordingRetentionDays: number;
  softDeleteRetentionDays: number;
  auditRetentionDays: number | null;
  backupCron: string;
  tlsReloadHour: number | null;
  autoUpdate: boolean;
  ssoProvider: (typeof SSO_PROVIDERS)[number] | null;
  ssoLabel: string | null;
  ssoIssuer: string | null;
  ssoClientId: string | null;
  ssoTenantId: string | null;
  ssoAllowedDomain: string | null;
  ssoClientSecret: string | null;
  ringotelOrgId: string | null;
  ringotelBranchId: string | null;
  ringotelMaxRegs: number;
  ringotelApiToken: string | null;
};

/** Fields only an owner may write (👑, §11.4); every other writable field is admin's. */
export const OWNER_FIELDS: ReadonlySet<keyof SettingsWire> = new Set([
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
export function checkFieldRole(field: keyof SettingsWire, role: Role): void {
  if (OWNER_FIELDS.has(field) && role !== 'owner') {
    throw new OpError(STATUS_FORBIDDEN, `settings: '${field}' is owner-only`);
  }
}

function maskSecret(enc: Buffer | null): string | null {
  return enc === null ? null : MASKED;
}

/** Loads the `settings` singleton row (`id = 1`, §11.1). */
export function loadSettings(db: Db): Promise<SettingsRow> {
  return db
    .selectFrom('settings')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
}

/** Maps a `settings` row to its wire shape, masking 🔒 secrets as `'***'` (§5.4, §11.4). */
export async function rowToWire(
  db: Db,
  row: SettingsRow
): Promise<SettingsWire> {
  return {
    companyName: row.companyName,
    mainDidId: row.mainDidId,
    country: row.country,
    timezone: row.timezone,
    language: row.language as Language,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecurity: row.smtpSecurity as (typeof SMTP_SECURITIES)[number],
    smtpUser: row.smtpUser,
    smtpPassword: maskSecret(row.smtpPasswordEnc),
    mailFrom: row.mailFrom,
    extLength: row.extLength,
    emergencyNumbers: JSON.parse(row.emergencyNumbersJson) as string[],
    featureCodes: JSON.parse(row.featureCodesJson) as FeatureCodes,
    fallbackTarget: await resolveOptionalTarget(db, row.fallbackTargetId),
    codecs: JSON.parse(row.codecsJson) as Codec[],
    clir: row.clir === 1,
    rejectAnonymous: row.rejectAnonymous === 1,
    holdMohAudioId: row.holdMohAudioId,
    voicemailMaxS: row.voicemailMaxS,
    parkingTimeoutS: row.parkingTimeoutS,
    callLogLevel: row.callLogLevel as (typeof CALL_LOG_LEVELS)[number],
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
    ssoClientSecret: maskSecret(row.ssoClientSecretEnc),
    ringotelOrgId: row.ringotelOrgId,
    ringotelBranchId: row.ringotelBranchId,
    ringotelMaxRegs: row.ringotelMaxRegs,
    ringotelApiToken: maskSecret(row.ringotelApiTokenEnc)
  };
}
