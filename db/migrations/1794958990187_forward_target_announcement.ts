import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// forward_targets — an announcement is no kind of its own any more (§10.1 step 7, §11.2):
// `announcement_audio_id` is set on a row of any kind and plays before the call goes where the row
// sends it, and a row that sends it nowhere, none of the eight targets set, ends the call
// (`hangup`). The rows of the former `announcement` kind are such rows already, so no row changes.
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('forward_targets')
    .dropConstraint('forward_targets_one_kind')
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .addCheckConstraint(
      'forward_targets_one_kind',
      sql`(user_id is not null) + (ring_group_id is not null) + (external is not null) +
             (sip_trunk_id is not null) + (web_socket_url is not null) +
             (mailbox_user_id is not null) + (mailbox_ring_group_id is not null) +
             (menu_id is not null) <= 1`
    )
    .execute();
}
