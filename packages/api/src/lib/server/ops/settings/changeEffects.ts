import { relaySettingsChanged } from '#lib/server/mail/relayCheck.js';
import { renderSipBanList } from '#lib/server/sipBanList.js';

import { afterCommit } from '../afterCommit.js';
import type { Context } from '../types.js';
import type { SettingsColumns, SettingsRow } from './_shared.js';
import { pushProfileAfterCommit } from './profilePush.js';

/** The reload kinds a changed set of columns requires (§3.1): `pjsip` and/or `moh`. The hold
 * music is each device endpoint's `moh_suggest` (§10.2 "Hold music"), so it moves PJSIP too. */
export function reloadKindsFor(columns: SettingsColumns): ('pjsip' | 'moh')[] {
  const kinds: ('pjsip' | 'moh')[] = [];
  if (
    'codecsJson' in columns ||
    'ringotelMaxRegs' in columns ||
    'holdMohAudioId' in columns
  ) {
    kinds.push('pjsip');
  }
  if ('holdMohAudioId' in columns) {
    kinds.push('moh');
  }
  return kinds;
}

// §10.4 onTenantProfileChanged: codecs and ringotelMaxRegs move the branch's provision object,
// language moves the organization's; any of them re-pushes the active Ringotel provider, once the
// write has committed and reached Asterisk ("Tenant profile push", `profilePush.ts`). The
// provision object also carries the DND, voicemail and park feature codes ("Branch provision
// profile"), so a feature-code change moves it too, or the app would dial retired codes.
// The connection's `country`, the default the app reads phone numbers against to match callers to
// contacts, follows the tenant's country, and its `emergency` list the tenant's emergency numbers.
const TENANT_PROFILE_COLUMNS = new Set([
  'codecsJson',
  'emergencyNumbersJson',
  'ringotelMaxRegs',
  'language',
  'featureCodesJson',
  'country'
]);

/**
 * Pushes the tenant's Ringotel profile (codecs, `ringotelMaxRegs`, feature codes, emergency
 * numbers, language, country) after the commit when it changed; the write never waits on
 * Ringotel, so its outage cannot fail it (§10.1 "Emergency calls", §10.4).
 */
export async function maybePushTenantProfile(
  ctx: Context,
  columns: SettingsColumns
): Promise<void> {
  const changed = Object.keys(columns).some(key =>
    TENANT_PROFILE_COLUMNS.has(key)
  );
  if (!changed) {
    return;
  }
  await pushProfileAfterCommit(ctx);
}

/**
 * Renders the ban list once a change of the escalation steps has committed: `[]` switches banning
 * off and renders the list empty, and switching it on again renders the active bans (§5.6, §9.1).
 */
export function maybeRenderSipBanList(
  ctx: Context,
  columns: SettingsColumns
): void {
  if ('sipBanStepsJson' in columns) {
    afterCommit(ctx, async db => {
      await renderSipBanList(db);
      return null;
    });
  }
}

// The columns that make the relay `verify()` checks (§10.2 "Relay check"); `mail_from` is not one.
const RELAY_COLUMNS = [
  'smtpHost',
  'smtpPort',
  'smtpSecurity',
  'smtpUser',
  'smtpPasswordEnc'
];

/** Whether `row` configures a relay: `smtp_host` and `mail_from` both set (§11.4). */
const configuresRelay = (row: {
  smtpHost?: string | null;
  mailFrom?: string | null;
}): boolean =>
  (row.smtpHost ?? null) !== null && (row.mailFrom ?? null) !== null;

/**
 * Checks the relay once a change of it, or one that configures it, `mail_from` included, has
 * committed, and times the next periodic check anew once a change of `smtp_check_interval_s`
 * has (§10.2 "Relay check").
 */
export function maybeCheckRelay(
  ctx: Context,
  before: SettingsRow,
  columns: SettingsColumns
): void {
  const relay =
    RELAY_COLUMNS.some(column => column in columns) ||
    (!configuresRelay(before) && configuresRelay({ ...before, ...columns }));
  if (relay || 'smtpCheckIntervalS' in columns) {
    afterCommit(ctx, () => {
      relaySettingsChanged({ relay });
      return Promise.resolve(null);
    });
  }
}
