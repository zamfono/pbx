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
const TENANT_PROFILE_COLUMNS = new Set([
  'codecsJson',
  'ringotelMaxRegs',
  'language',
  'featureCodesJson'
]);

/** Pushes the tenant's Ringotel profile (codecs, `ringotelMaxRegs`, feature codes, language) when it changed. */
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
