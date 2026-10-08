/**
 * The tenant settings (`ops/settings/`, §11.4): `settings.get` and `settings.update`. Secrets are
 * write-only: the read carries `<name>Set`; a write takes `undefined` (keep), `null` (clear) or a
 * string (set), and a write that touches one is masked in the audit diff and not undoable.
 * Owner-only fields (`OWNER_FIELDS`) refuse an admin with 403.
 */
import { isCronExpression } from '#lib/components/system/cron.js';
import { onDemoReset } from '#lib/state/demo.js';

import { invalid, notFound } from '../../errors';
import { store, touch } from '../../store.svelte';
import {
  CALL_LOG_LEVELS,
  CODECS,
  FEATURE_CODE_KEYS,
  LANGUAGES,
  type ChangeEntry,
  type Db,
  type FeatureCodes,
  type ForwardTarget,
  type Settings
} from '../../types';
import { defineOp, type Ctx } from '../core';
import { E164, requireInt, requireTimeout } from '../validate';

export const SECRET_FIELDS = [
  'smtpPassword',
  'ssoClientSecret',
  'ringotelApiToken'
] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

/** Read-only on the wire: never part of an update. */
type ReadOnlyField =
  'extLength' | 'ringotelOrgId' | 'ringotelBranchId' | `${string}Set`;

export type SettingsInput = Partial<Omit<Settings, ReadOnlyField>> &
  Partial<Record<SecretField, string | null>>;

/** Fields only an owner may write (`settings/_shared.ts` `OWNER_FIELDS`). */
export const OWNER_FIELDS: ReadonlySet<string> = new Set([
  'smtpHost',
  'smtpPort',
  'smtpSecurity',
  'smtpUser',
  'smtpPassword',
  'mailFrom',
  'smtpCheckIntervalS',
  'emergencyNumbers',
  'auditRetentionDays',
  'autoUpdate',
  'mfaRequiredForAll',
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

/** Changing one of these invalidates every user's SSO binding (§5.2). */
export const SSO_RESET_FIELDS = [
  'ssoProvider',
  'ssoIssuer',
  'ssoTenantId'
] as const;

/** The columns whose change re-pushes the tenant's Ringotel profile (`changeEffects.ts`). */
const PROFILE_FIELDS = new Set([
  'codecs',
  'emergencyNumbers',
  'ringotelMaxRegs',
  'language',
  'featureCodes',
  'country'
]);

const SECRET_SET: Record<
  SecretField,
  'smtpPasswordSet' | 'ssoClientSecretSet' | 'ringotelApiTokenSet'
> = {
  smtpPassword: 'smtpPasswordSet',
  ssoClientSecret: 'ssoClientSecretSet',
  ringotelApiToken: 'ringotelApiTokenSet'
};

const MASK = '•••';
const MAX_RETENTION_DAYS = 36_500;
const MIN_AUDIT_RETENTION_DAYS = 30;
const MAX_SIP_BAN_PERIOD_S = 3_153_600_000;
const MIN_SIP_BAN_STEP_S = 60;
const MAX_PORT = 65_535;
const PROFILE_PUSH_MS = 2500;
const WRITABLE_FIELDS = new Set<string>([
  'companyName',
  'mainDidId',
  'country',
  'timezone',
  'language',
  'smtpHost',
  'smtpPort',
  'smtpSecurity',
  'smtpUser',
  'smtpPassword',
  'mailFrom',
  'smtpCheckIntervalS',
  'emergencyNumbers',
  'featureCodes',
  'fallbackTarget',
  'codecs',
  'clir',
  'rejectAnonymous',
  'holdMohAudioId',
  'voicemailMaxS',
  'parkingTimeoutS',
  'callLogLevel',
  'recordingRetentionDays',
  'softDeleteRetentionDays',
  'auditRetentionDays',
  'sipBanFailures',
  'sipBanWindowS',
  'sipBanSuccessExemptS',
  'sipBanLookbackS',
  'sipBanSteps',
  'backupCron',
  'tlsReloadHour',
  'autoUpdate',
  'mfaRequiredForAll',
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

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

/** A nullable whole number in `min`–`max`. */
function nullableInt(
  field: string,
  value: unknown,
  min: number,
  max: number
): number | null {
  return value === null ? null : requireInt(field, value, min, max);
}

/** The ten feature codes: every key, each starting with * or #, none a prefix of another (§9.3). */
export function checkFeatureCodes(codes: unknown): FeatureCodes {
  const record = (codes ?? {}) as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== FEATURE_CODE_KEYS.length ||
    !FEATURE_CODE_KEYS.every(key => typeof record[key] === 'string')
  ) {
    throw invalid(
      'featureCodes',
      'featureCodeKeys',
      'featureCodes: all ten keys are required'
    );
  }
  const typed = record as FeatureCodes;
  for (const key of FEATURE_CODE_KEYS) {
    if (!/^[*#]/u.test(typed[key])) {
      throw invalid(
        `featureCodes.${key}`,
        'featureCodeStart',
        `${key}: must start with * or #`,
        { code: typed[key] }
      );
    }
  }
  for (const key of FEATURE_CODE_KEYS) {
    for (const other of FEATURE_CODE_KEYS) {
      if (key !== other && typed[other] === typed[key]) {
        throw invalid(
          `featureCodes.${other}`,
          'featureCodeSame',
          `'${typed[key]}' is used twice (${key}, ${other})`,
          { code: typed[key], key, otherKey: other }
        );
      }
      if (key !== other && typed[other].startsWith(typed[key])) {
        throw invalid(
          `featureCodes.${other}`,
          'featureCodePrefix',
          `'${typed[key]}' (${key}) is a prefix of '${typed[other]}' (${other})`,
          {
            code: typed[key],
            other: typed[other],
            key,
            otherKey: other
          }
        );
      }
    }
  }
  return { ...typed };
}

/** Ban lengths: each 60 s to 100 years, longer than the one before, `null` only last; `[]` is off. */
export function checkSipBanSteps(steps: unknown): (number | null)[] {
  if (!Array.isArray(steps)) {
    throw invalid('sipBanSteps', 'sipBanSteps', 'sipBanSteps must be a list');
  }
  steps.forEach((step: unknown, index) => {
    if (step === null) {
      if (index !== steps.length - 1) {
        throw invalid(
          'sipBanSteps',
          'sipBanStepsPermanentLast',
          'null (permanent) only as the last step'
        );
      }
      return;
    }
    if (
      typeof step !== 'number' ||
      !Number.isInteger(step) ||
      step < MIN_SIP_BAN_STEP_S ||
      step > MAX_SIP_BAN_PERIOD_S
    ) {
      throw invalid(
        'sipBanSteps',
        'sipBanStepsRange',
        'each step is 60 s to 100 years',
        { min: MIN_SIP_BAN_STEP_S }
      );
    }
    const previous = steps[index - 1] as number | null | undefined;
    if (previous !== undefined && (previous === null || step <= previous)) {
      throw invalid(
        'sipBanSteps',
        'sipBanStepsIncreasing',
        'each step must be longer than the one before'
      );
    }
  });
  return [...(steps as (number | null)[])];
}

function checkTargetLive(db: Db, target: ForwardTarget): void {
  const live = <T extends { id: string; deletedAt: string | null }>(
    rows: T[],
    id: string
  ): boolean => rows.some(row => row.id === id && row.deletedAt === null);
  const ok = ((): boolean => {
    switch (target.kind) {
      case 'user':
      case 'mailboxUser':
        return live(db.users, target.userId);
      case 'ringGroup':
      case 'mailboxRingGroup':
        return live(db.ringGroups, target.ringGroupId);
      case 'external':
        return E164.test(target.external);
      case 'sip':
        return live(db.trunks, target.trunkId) && target.user.trim() !== '';
      case 'announcement':
        return live(db.audio, target.audioId);
      case 'menu':
        return live(db.menus, target.menuId);
    }
  })();
  if (!ok) {
    if (target.kind === 'external') {
      throw invalid(
        'fallbackTarget',
        'settingsFallbackExternal',
        'external must be E.164',
        { value: target.external }
      );
    }
    throw notFound('fallbackTarget', target.kind);
  }
}

/** Validates `input` against the merged settings (`settings/_input.ts`, `update.ts`). */
function validate(db: Db, before: Settings, input: SettingsInput): void {
  for (const key of Object.keys(input)) {
    if (!WRITABLE_FIELDS.has(key)) {
      throw invalid(key, 'settingsReadOnly', `${key} cannot be written`, {
        field: key
      });
    }
  }
  if (input.companyName !== undefined && input.companyName.trim() === '') {
    throw invalid('companyName', 'required', 'companyName is required');
  }
  if (input.mainDidId !== undefined && input.mainDidId !== before.mainDidId) {
    const did = db.dids.find(
      row => row.id === input.mainDidId && row.deletedAt === null
    );
    if (did === undefined || !E164.test(did.number)) {
      throw invalid(
        'mainDidId',
        'settingsMainDid',
        'mainDidId must be a live numeric DID'
      );
    }
  }
  if (input.country !== undefined && !/^[A-Z]{2}$/u.test(input.country)) {
    throw invalid(
      'country',
      'settingsCountry',
      'country must be an ISO 3166-1 alpha-2 code'
    );
  }
  if (
    input.timezone !== undefined &&
    input.timezone !== null &&
    !isTimeZone(input.timezone)
  ) {
    throw invalid(
      'timezone',
      'settingsTimezone',
      'timezone must be an IANA time zone'
    );
  }
  if (input.language !== undefined && !LANGUAGES.includes(input.language)) {
    throw invalid('language', 'invalid', 'unknown language', {
      message: input.language
    });
  }
  if (
    input.smtpHost !== undefined &&
    input.smtpHost !== null &&
    input.smtpHost.trim() === ''
  ) {
    throw invalid(
      'smtpHost',
      'required',
      'smtpHost must not be empty; null sends no mail'
    );
  }
  if (input.smtpPort !== undefined) {
    requireInt('smtpPort', input.smtpPort, 1, MAX_PORT);
  }
  if (input.smtpCheckIntervalS !== undefined) {
    nullableInt('smtpCheckIntervalS', input.smtpCheckIntervalS, 60, 86_400);
  }
  if (input.emergencyNumbers !== undefined) {
    const numbers = input.emergencyNumbers;
    if (
      numbers.length === 0 ||
      numbers.some(number => !/^[0-9]+$/u.test(number))
    ) {
      throw invalid(
        'emergencyNumbers',
        'settingsEmergencyDigits',
        'emergencyNumbers: one or more digit strings'
      );
    }
    const taken = numbers.filter(
      number =>
        db.users.some(
          user => user.deletedAt === null && user.extension === number
        ) ||
        db.ringGroups.some(
          group => group.deletedAt === null && group.ext === number
        ) ||
        db.parkingSlots.includes(number)
    );
    if (taken.length > 0) {
      throw invalid(
        'emergencyNumbers',
        'settingsEmergencyExtension',
        'already a live extension',
        { list: taken.join(', ') }
      );
    }
  }
  if (input.featureCodes !== undefined) {
    checkFeatureCodes(input.featureCodes);
  }
  if (input.fallbackTarget !== undefined && input.fallbackTarget !== null) {
    checkTargetLive(db, input.fallbackTarget);
  }
  if (input.codecs !== undefined) {
    if (
      input.codecs.length === 0 ||
      input.codecs.some(codec => !CODECS.includes(codec))
    ) {
      throw invalid(
        'codecs',
        'settingsCodecs',
        'codecs: an ordered, non-empty list'
      );
    }
  }
  if (input.holdMohAudioId !== undefined && input.holdMohAudioId !== null) {
    const asset = db.audio.find(
      row => row.id === input.holdMohAudioId && row.deletedAt === null
    );
    if (asset === undefined || asset.kind !== 'moh') {
      throw invalid(
        'holdMohAudioId',
        'settingsMohAudio',
        'holdMohAudioId must be a moh asset'
      );
    }
  }
  if (input.voicemailMaxS !== undefined) {
    requireTimeout('voicemailMaxS', input.voicemailMaxS);
  }
  if (input.parkingTimeoutS !== undefined) {
    requireTimeout('parkingTimeoutS', input.parkingTimeoutS);
  }
  if (
    input.callLogLevel !== undefined &&
    !CALL_LOG_LEVELS.includes(input.callLogLevel)
  ) {
    throw invalid('callLogLevel', 'invalid', 'unknown level', {
      message: input.callLogLevel
    });
  }
  if (input.recordingRetentionDays !== undefined) {
    nullableInt(
      'recordingRetentionDays',
      input.recordingRetentionDays,
      1,
      MAX_RETENTION_DAYS
    );
  }
  if (input.softDeleteRetentionDays !== undefined) {
    nullableInt(
      'softDeleteRetentionDays',
      input.softDeleteRetentionDays,
      1,
      MAX_RETENTION_DAYS
    );
  }
  if (input.auditRetentionDays !== undefined) {
    nullableInt(
      'auditRetentionDays',
      input.auditRetentionDays,
      MIN_AUDIT_RETENTION_DAYS,
      MAX_RETENTION_DAYS
    );
  }
  const softDelete =
    input.softDeleteRetentionDays === undefined
      ? before.softDeleteRetentionDays
      : input.softDeleteRetentionDays;
  const audit =
    input.auditRetentionDays === undefined
      ? before.auditRetentionDays
      : input.auditRetentionDays;
  if (audit !== null && (softDelete === null || softDelete > audit)) {
    throw invalid(
      'softDeleteRetentionDays',
      'settingsRetentionWindow',
      'softDeleteRetentionDays must not exceed auditRetentionDays',
      {
        softDelete: softDelete ?? '∞',
        audit
      }
    );
  }
  if (input.sipBanFailures !== undefined) {
    requireInt(
      'sipBanFailures',
      input.sipBanFailures,
      1,
      Number.MAX_SAFE_INTEGER
    );
  }
  if (input.sipBanWindowS !== undefined) {
    requireInt('sipBanWindowS', input.sipBanWindowS, 1, MAX_SIP_BAN_PERIOD_S);
  }
  if (input.sipBanSuccessExemptS !== undefined) {
    requireInt(
      'sipBanSuccessExemptS',
      input.sipBanSuccessExemptS,
      0,
      MAX_SIP_BAN_PERIOD_S
    );
  }
  if (input.sipBanLookbackS !== undefined) {
    requireInt(
      'sipBanLookbackS',
      input.sipBanLookbackS,
      1,
      MAX_SIP_BAN_PERIOD_S
    );
  }
  if (input.sipBanSteps !== undefined) {
    checkSipBanSteps(input.sipBanSteps);
  }
  if (input.backupCron !== undefined && !isCronExpression(input.backupCron)) {
    throw invalid(
      'backupCron',
      'settingsCron',
      'backupCron must be a cron expression'
    );
  }
  if (input.tlsReloadHour !== undefined) {
    nullableInt('tlsReloadHour', input.tlsReloadHour, 0, 23);
  }
  if (input.ringotelMaxRegs !== undefined) {
    requireInt(
      'ringotelMaxRegs',
      input.ringotelMaxRegs,
      1,
      Number.MAX_SAFE_INTEGER
    );
  }
  const merged = { ...before, ...input };
  if (merged.ssoProvider !== null && merged.ssoProvider !== undefined) {
    if (!['microsoft', 'google', 'oidc'].includes(merged.ssoProvider)) {
      throw invalid('ssoProvider', 'invalid', 'unknown provider', {
        message: merged.ssoProvider
      });
    }
    if (merged.ssoClientId === null || merged.ssoClientId.trim() === '') {
      throw invalid(
        'ssoClientId',
        'settingsSsoClientId',
        'ssoClientId is required once ssoProvider is set'
      );
    }
    if (
      merged.ssoProvider === 'microsoft' &&
      (merged.ssoTenantId === null || merged.ssoTenantId.trim() === '')
    ) {
      throw invalid(
        'ssoTenantId',
        'settingsSsoTenantId',
        "ssoTenantId is required for 'microsoft'"
      );
    }
    if (
      merged.ssoProvider === 'oidc' &&
      (merged.ssoIssuer === null ||
        merged.ssoLabel === null ||
        merged.ssoIssuer.trim() === '' ||
        merged.ssoLabel.trim() === '')
    ) {
      throw invalid(
        merged.ssoIssuer === null || merged.ssoIssuer.trim() === ''
          ? 'ssoIssuer'
          : 'ssoLabel',
        'settingsSsoOidc',
        "ssoIssuer and ssoLabel are required for 'oidc'"
      );
    }
  }
}

/** Whether a relay is configured: `smtpHost` and `mailFrom` both set (§11.4). */
export const relayConfigured = (settings: Settings): boolean =>
  settings.smtpHost !== null && settings.mailFrom !== null;

/** How many users an SSO binding change would unbind (§5.2). */
export function ssoBoundUsers(db: Db): number {
  return db.users.filter(user => user.deletedAt === null && user.ssoBound)
    .length;
}

let pushTimer: ReturnType<typeof setTimeout> | undefined;
onDemoReset(() => clearTimeout(pushTimer));

/** The tenant profile push after a change (§10.4): pending until Ringotel has it. */
function pushProfile(db: Db): void {
  if (db.settings.ringotelOrgId === null) {
    return;
  }
  db.system.ringotel.profilePending = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    store.db.system.ringotel.profilePending = false;
    touch();
  }, PROFILE_PUSH_MS);
}

defineOp<Record<string, never>, Settings>({
  name: 'settings.get',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({ ...ctx.db.settings })
});

defineOp<SettingsInput, Settings>({
  name: 'settings.update',
  minRole: 'admin',
  ownerOnly: (_ctx, input) =>
    Object.keys(input).some(key => OWNER_FIELDS.has(key)),
  run: (ctx: Ctx, input) => {
    const before = { ...ctx.db.settings };
    validate(ctx.db, before, input);
    const after: Settings = { ...before };
    const changes: ChangeEntry[] = [];
    let secretTouched = false;
    for (const [key, value] of Object.entries(input) as [string, unknown][]) {
      if ((SECRET_FIELDS as readonly string[]).includes(key)) {
        const field = key as SecretField;
        after[SECRET_SET[field]] = value !== null;
        changes.push({ field, from: MASK, to: MASK });
        secretTouched = true;
        continue;
      }
      const field = key as keyof Settings;
      const next =
        typeof value === 'string' && field !== 'backupCron'
          ? value.trim()
          : value;
      if (!same(before[field], next)) {
        changes.push({ field, from: before[field] ?? null, to: next ?? null });
        (after as Record<string, unknown>)[field] = next;
      }
    }
    if (changes.length === 0) {
      return { ...before };
    }
    const resetsSso = SSO_RESET_FIELDS.some(
      field => field in input && !same(input[field], before[field])
    );
    if (resetsSso) {
      const bound = ctx.db.users.filter(user => user.ssoBound);
      for (const user of bound) {
        ctx.put('users', { ...user, ssoBound: false });
      }
      if (bound.length > 0) {
        changes.push({
          field: 'ssoSubjects',
          from: bound.map(user => ({ userId: user.id })),
          to: []
        });
      }
    }
    ctx.setRoot('settings', after);
    if (changes.some(change => PROFILE_FIELDS.has(change.field))) {
      pushProfile(ctx.db);
    }
    ctx.audit({
      entityKind: 'settings',
      entityId: 'settings',
      changes,
      undoable: !secretTouched
    });
    return { ...after };
  }
});
