import { loadBranding } from '#lib/server/auth/branding.js';
import { getDb } from '#lib/server/db.js';

import type { LayoutServerLoad } from './$types.js';

/**
 * Every page `api` serves, the authentication pages (§5.2) and the upload page (§10.5), is
 * rendered in the tenant's language with its company name as the title. A layout load runs independently of the page load below
 * it, so an error page (`+error.svelte`) still has both when that page load throws.
 */
export const load: LayoutServerLoad = () => loadBranding(getDb());
