import { recordChange } from '../runner.js';
import type { Context } from '../types.js';
import type { SettingsWire } from './_shared.js';

type FieldTransform = {
  column: string;
  encode?: (value: unknown) => unknown;
  decode?: (raw: unknown) => unknown;
};

const identity = (value: unknown): unknown => value;
const toBit = (value: unknown): unknown => (value ? 1 : 0);
const fromBit = (raw: unknown): unknown => raw === 1;
const toJson = (value: unknown): unknown => JSON.stringify(value);
const fromJson = (raw: unknown): unknown =>
  JSON.parse(raw as string) as unknown;

/**
 * Every plain settings field: its column, and, where the wire and column representations differ,
 * how to encode a write and decode the stored value back for the audit diff (§10.3, §11.4).
 */
const FIELD_TRANSFORMS: Partial<Record<keyof SettingsWire, FieldTransform>> = {
  companyName: { column: 'companyName' },
  country: { column: 'country' },
  timezone: { column: 'timezone' },
  language: { column: 'language' },
  smtpHost: { column: 'smtpHost' },
  smtpPort: { column: 'smtpPort' },
  smtpSecurity: { column: 'smtpSecurity' },
  smtpUser: { column: 'smtpUser' },
  mailFrom: { column: 'mailFrom' },
  voicemailMaxS: { column: 'voicemailMaxS' },
  parkingTimeoutS: { column: 'parkingTimeoutS' },
  recordingRetentionDays: { column: 'recordingRetentionDays' },
  softDeleteRetentionDays: { column: 'softDeleteRetentionDays' },
  auditRetentionDays: { column: 'auditRetentionDays' },
  backupCron: { column: 'backupCron' },
  tlsReloadHour: { column: 'tlsReloadHour' },
  callLogLevel: { column: 'callLogLevel' },
  ssoProvider: { column: 'ssoProvider' },
  ssoLabel: { column: 'ssoLabel' },
  ssoIssuer: { column: 'ssoIssuer' },
  ssoClientId: { column: 'ssoClientId' },
  ssoTenantId: { column: 'ssoTenantId' },
  ssoAllowedDomain: { column: 'ssoAllowedDomain' },
  ringotelMaxRegs: { column: 'ringotelMaxRegs' },
  clir: { column: 'clir', encode: toBit, decode: fromBit },
  rejectAnonymous: {
    column: 'rejectAnonymous',
    encode: toBit,
    decode: fromBit
  },
  autoUpdate: { column: 'autoUpdate', encode: toBit, decode: fromBit },
  emergencyNumbers: {
    column: 'emergencyNumbersJson',
    encode: toJson,
    decode: fromJson
  },
  codecs: { column: 'codecsJson', encode: toJson, decode: fromJson }
};

/** Applies every `FIELD_TRANSFORMS` field present in `input` whose encoded value changed. */
export function applyPlainFields(
  ctx: Context,
  before: Record<string, unknown>,
  input: Record<string, unknown>,
  columns: Record<string, unknown>
): void {
  for (const [field, transform] of Object.entries(FIELD_TRANSFORMS)) {
    if (!(field in input)) {
      continue;
    }
    const encode = transform.encode ?? identity;
    const decode = transform.decode ?? identity;
    const encoded = encode(input[field]);
    if (encoded !== before[transform.column]) {
      recordChange(ctx, {
        field,
        from: decode(before[transform.column]),
        to: input[field]
      });
      columns[transform.column] = encoded;
    }
  }
}
