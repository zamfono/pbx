import { z } from 'zod';

import { isIanaTimeZone } from '@zamfono/shared';

import { isCronExpression } from '../../jobs/cronExpression.js';
import { targetInputSchema } from '../dids/_shared.js';
import { propagate } from '../runner.js';
import { CODECS } from '../trunks/_shared.js';
import { defineOperation, OpError, type Role } from '../types.js';
import {
  CALL_LOG_LEVELS,
  checkFieldRole,
  LANGUAGES,
  loadSettings,
  rowToWire,
  SMTP_SECURITIES,
  SSO_PROVIDERS,
  type SettingsRow,
  type SettingsWire
} from './_shared.js';
import { maybePushTenantProfile, reloadKindsFor } from './changeEffects.js';
import { isKnownCountry } from './country.js';
import { assertNoExtensionCollision } from './emergencyNumbers.js';
import { applyFeatureCodes } from './featureCodes.js';
import { applyPlainFields } from './plainFields.js';
import {
  applyFallbackTarget,
  applyHoldMohAudioId,
  applyMainDidId
} from './referenceFields.js';
import { applySecretFields } from './secrets.js';
import { assertSsoInvariants, maybeResetSsoSubjects } from './sso.js';

const STATUS_UNPROCESSABLE_ENTITY = 422;
const MAX_SMTP_PORT = 65535;
const MAX_TLS_RELOAD_HOUR = 23;
const MIN_AUDIT_RETENTION_DAYS = 30;
const COUNTRY_CODE_LENGTH = 2;

const inputSchema = z
  .object({
    companyName: z.string().min(1).optional(),
    mainDidId: z.string().optional(),
    country: z.string().length(COUNTRY_CODE_LENGTH).optional(),
    timezone: z
      .string()
      .refine(isIanaTimeZone, 'timezone must be an IANA time zone')
      .nullish(),
    language: z.enum(LANGUAGES).optional(),
    smtpHost: z.string().min(1).nullish(),
    smtpPort: z.number().int().min(1).max(MAX_SMTP_PORT).optional(),
    smtpSecurity: z.enum(SMTP_SECURITIES).optional(),
    smtpUser: z.string().nullish(),
    smtpPassword: z.string().nullish(),
    mailFrom: z.string().nullish(),
    emergencyNumbers: z
      .array(z.string().regex(/^[0-9]+$/u))
      .min(1)
      .optional(),
    featureCodes: z.record(z.string(), z.string()).optional(),
    fallbackTarget: targetInputSchema.nullable().optional(),
    codecs: z.array(z.enum(CODECS)).min(1).optional(),
    clir: z.boolean().optional(),
    rejectAnonymous: z.boolean().optional(),
    holdMohAudioId: z.string().nullish(),
    voicemailMaxS: z.number().int().positive().optional(),
    parkingTimeoutS: z.number().int().positive().optional(),
    callLogLevel: z.enum(CALL_LOG_LEVELS).optional(),
    recordingRetentionDays: z.number().int().positive().optional(),
    softDeleteRetentionDays: z.number().int().min(1).optional(),
    auditRetentionDays: z
      .number()
      .int()
      .min(MIN_AUDIT_RETENTION_DAYS)
      .nullish(),
    backupCron: z
      .string()
      .min(1)
      .refine(isCronExpression, 'backupCron must be a cron expression')
      .optional(),
    tlsReloadHour: z.number().int().min(0).max(MAX_TLS_RELOAD_HOUR).nullish(),
    ssoProvider: z.enum(SSO_PROVIDERS).nullish(),
    ssoLabel: z.string().nullish(),
    ssoIssuer: z.string().nullish(),
    ssoClientId: z.string().nullish(),
    ssoTenantId: z.string().nullish(),
    ssoAllowedDomain: z.string().nullish(),
    ssoClientSecret: z.string().nullish(),
    ringotelMaxRegs: z.number().int().positive().optional(),
    ringotelApiToken: z.string().nullish()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

function assertFieldRoles(input: Input, role: Role): void {
  for (const field of Object.keys(input) as (keyof SettingsWire)[]) {
    checkFieldRole(field, role);
  }
}

/** Refuses a `country` outside the ISO 3166-1 alpha-2 set libphonenumber knows (§11.4). */
function assertKnownCountry(country: Input['country']): void {
  if (country !== undefined && !isKnownCountry(country)) {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      `settings: unknown country '${country}'`
    );
  }
}

/** Refuses `callLogLevel: 'sip'` while the deployment mirrors no SIP traffic (§7, §11.4). */
function assertCallLogLevel(level: Input['callLogLevel']): void {
  const hepEnabled = process.env.HEP_ENABLED !== 'false';
  if (level === 'sip' && !hepEnabled) {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      "settings: callLogLevel 'sip' requires HEP_ENABLED"
    );
  }
}

/**
 * `PATCH /settings` (§10.3, §11.4): a partial update of the tenant settings row. Owner-only fields
 * are enforced by `checkFieldRole`; the three read-only columns (`extLength`, `ringotelOrgId`,
 * `ringotelBranchId`) are absent from the schema, so submitting them is a plain 422.
 */
export const update = defineOperation<Input, SettingsWire>({
  name: 'settings.update',
  description: 'Updates the tenant settings row',
  input: inputSchema,
  minRole: 'admin',
  entity: () => ({ kind: 'settings', id: 'settings' }),
  run: async (ctx, input) => {
    assertFieldRoles(input, ctx.actor.role);
    const before = await loadSettings(ctx.db);
    assertKnownCountry(input.country);
    await assertNoExtensionCollision(ctx, input.emergencyNumbers);
    assertCallLogLevel(input.callLogLevel);
    const beforeRecord = before as unknown as Record<string, unknown>;
    const inputRecord = input as unknown as Record<string, unknown>;
    assertSsoInvariants(before, inputRecord);
    const columns: Record<string, unknown> = {};
    applyPlainFields(ctx, beforeRecord, inputRecord, columns);
    applyFeatureCodes(ctx, before, input.featureCodes, columns);
    applySecretFields(ctx, inputRecord, columns);
    await applyMainDidId(ctx, before, input, columns);
    await applyHoldMohAudioId(ctx, before, input, columns);
    await applyFallbackTarget(ctx, before, input, columns);
    await maybeResetSsoSubjects(ctx, beforeRecord, inputRecord);
    if (Object.keys(columns).length > 0) {
      await ctx.db
        .updateTable('settings')
        .set(columns as unknown as SettingsRow)
        .where('id', '=', 1)
        .execute();
      // §3.1 "Config propagation": every written column is configuration `core` reads (even a
      // field with no reload kind of its own, `language` among them, §11.4), so `core`'s config
      // cache must drop whether or not Asterisk itself needs a reload — the same unconditional
      // `propagate()` every other operation that writes core-relevant configuration makes
      // (`dids/update.ts`, `ooo/update.ts`, `outboundRoutes/replace.ts`, …). Gating this call
      // itself on `reloadKinds` left `core` serving a stale snapshot after a write that changed
      // no PJSIP/MOH column.
      propagate(ctx, reloadKindsFor(columns));
    }
    await maybePushTenantProfile(ctx, columns);
    return rowToWire(ctx.db, await loadSettings(ctx.db));
  }
});
