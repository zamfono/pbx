import {
  codecsColumn,
  emergencyNumbersColumn,
  featureCodesColumn,
  sipBanStepsColumn
} from '@zamfono/shared';

import { fromFlag, recordFieldChanges } from '../audit.js';
import type { Context } from '../types.js';
import type { SettingsInput } from './_input.js';
import type { SettingsColumns, SettingsRow } from './_shared.js';

const toBit = (value: unknown): number => (value ? 1 : 0);
const toJson = (value: unknown): string => JSON.stringify(value);

/**
 * Every plain settings column: where the wire and column representations differ, the wire field
 * it is written from, how to encode a write and how to decode the stored value back for the audit
 * diff (§10.3, §11.4). A column with neither is its own wire field and value.
 */
const PLAIN_COLUMNS: {
  [Column in keyof SettingsRow]?: {
    field?: keyof SettingsInput;
    encode?: (value: unknown) => SettingsRow[Column];
    decode?: (stored: SettingsRow[Column]) => unknown;
  };
} = {
  companyName: {},
  country: {},
  timezone: {},
  language: {},
  smtpHost: {},
  smtpPort: {},
  smtpSecurity: {},
  smtpUser: {},
  mailFrom: {},
  voicemailMaxS: {},
  parkingTimeoutS: {},
  recordingRetentionDays: {},
  softDeleteRetentionDays: {},
  auditRetentionDays: {},
  backupCron: {},
  tlsReloadHour: {},
  callLogLevel: {},
  ssoProvider: {},
  ssoLabel: {},
  ssoIssuer: {},
  ssoClientId: {},
  ssoTenantId: {},
  ssoAllowedDomain: {},
  ringotelMaxRegs: {},
  sipBanFailures: {},
  sipBanWindowS: {},
  sipBanSuccessExemptS: {},
  sipBanLookbackS: {},
  clir: { encode: toBit, decode: fromFlag },
  rejectAnonymous: { encode: toBit, decode: fromFlag },
  autoUpdate: { encode: toBit, decode: fromFlag },
  emergencyNumbersJson: {
    field: 'emergencyNumbers',
    encode: toJson,
    decode: stored => emergencyNumbersColumn.decode(stored)
  },
  codecsJson: {
    field: 'codecs',
    encode: toJson,
    decode: stored => codecsColumn.decode(stored)
  },
  featureCodesJson: {
    field: 'featureCodes',
    encode: toJson,
    decode: stored => featureCodesColumn.decode(stored)
  },
  sipBanStepsJson: {
    field: 'sipBanSteps',
    encode: toJson,
    decode: stored => sipBanStepsColumn.decode(stored)
  }
};

/** Applies every `PLAIN_COLUMNS` column whose wire field is present in `input` and whose encoded
 * value changed. */
export function applyPlainFields(
  ctx: Context,
  before: SettingsRow,
  input: SettingsInput,
  columns: SettingsColumns
): void {
  const after: Record<string, unknown> = {};
  for (const [column, plain] of Object.entries(PLAIN_COLUMNS)) {
    const field = plain.field ?? (column as keyof SettingsInput);
    if (field in input) {
      after[column] = plain.encode ? plain.encode(input[field]) : input[field];
    }
  }
  Object.assign(
    columns,
    recordFieldChanges(
      ctx,
      before,
      after as Partial<SettingsRow>,
      PLAIN_COLUMNS
    )
  );
}
