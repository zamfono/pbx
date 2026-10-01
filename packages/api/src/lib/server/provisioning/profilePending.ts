import type { Db } from '@zamfono/shared';

/**
 * `settings.ringotel_profile_pending` (§10.4 "Tenant profile push", §11.4): set while a change to
 * the tenant's Ringotel profile has been stored but has not reached Ringotel. The profile lies in
 * the branch and in the organization (the language), so only a push that delivered both clears
 * it: the profile push itself, setup and adoption. A roster push or the re-registration, which
 * carry the branch alone, leave it set.
 */
export async function setProfilePending(
  db: Db,
  pending: boolean
): Promise<void> {
  await db
    .updateTable('settings')
    .set({ ringotelProfilePending: pending ? 1 : 0 })
    .where('id', '=', 1)
    .execute();
}

/** Whether the tenant's Ringotel profile still waits for a push Ringotel takes. */
export async function isProfilePending(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('settings')
    .select('ringotelProfilePending')
    .where('id', '=', 1)
    .executeTakeFirst();
  return row?.ringotelProfilePending === 1;
}
