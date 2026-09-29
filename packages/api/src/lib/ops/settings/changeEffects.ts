import { activeRingotelProvider } from '../../provisioning/index.js';
import type { Context } from '../types.js';
import { loadSettings } from './_shared.js';

/** The reload kinds a changed set of columns requires (§3.1): `pjsip` and/or `moh`. The hold
 * music is each device endpoint's `moh_suggest` (§10.2 "Hold music"), so it moves PJSIP too. */
export function reloadKindsFor(
  columns: Record<string, unknown>
): ('pjsip' | 'moh')[] {
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
// language moves the organization's; any of them re-pushes the active Ringotel provider. The
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

/** Pushes the tenant's Ringotel profile (codecs, `ringotelMaxRegs`, feature codes, emergency numbers, language, country) when it changed. */
export async function maybePushTenantProfile(
  ctx: Context,
  columns: Record<string, unknown>
): Promise<void> {
  const changed = Object.keys(columns).some(key =>
    TENANT_PROFILE_COLUMNS.has(key)
  );
  if (!changed) {
    return;
  }
  const provider = await activeRingotelProvider(ctx.db);
  await provider?.onTenantProfileChanged?.(await loadSettings(ctx.db));
}
