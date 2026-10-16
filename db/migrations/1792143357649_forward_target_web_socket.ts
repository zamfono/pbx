import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// forward_targets — the `webSocket` kind (§9.4 "WebSocket targets", §11.2): a voice bot reached
// over a WebSocket, which speaks the `twilio` or `vonage` protocol at its sample rate, 8000 for
// `twilio`. The three columns are set together, the kind is one of the nine, and such a target
// may record like an `external` or `sip` one. `record_calls`' CHECK is the column's own, which
// SQLite cannot drop, so the column is replaced by one with the wider CHECK, its values copied.
export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('forward_targets')
    .addColumn('web_socket_protocol', 'text', col =>
      col.check(sql`web_socket_protocol in ('twilio','vonage')`)
    )
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .addColumn('web_socket_url', 'text', col =>
      col.check(
        sql`web_socket_url is null or ((web_socket_url glob 'ws://?*' or web_socket_url glob 'wss://?*') and length(web_socket_url) <= 2048)`
      )
    )
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .addColumn('web_socket_sample_rate', 'integer', col =>
      col.check(sql`web_socket_sample_rate in (8000,16000,24000)`)
    )
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .addCheckConstraint(
      'forward_targets_web_socket',
      sql`(web_socket_url is null) = (web_socket_protocol is null)
            and (web_socket_url is null) = (web_socket_sample_rate is null)
            and (web_socket_protocol is not 'twilio' or web_socket_sample_rate = 8000)`
    )
    .execute();
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
             (announcement_audio_id is not null) + (menu_id is not null) = 1`
    )
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .addColumn('record_calls_next', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(
          sql`record_calls_next in (0,1) and (record_calls_next = 0 or external is not null or sip_trunk_id is not null or web_socket_url is not null)`
        )
    )
    .execute();
  await sql`UPDATE forward_targets SET record_calls_next = record_calls`.execute(
    db
  );
  await db.schema
    .alterTable('forward_targets')
    .dropColumn('record_calls')
    .execute();
  await db.schema
    .alterTable('forward_targets')
    .renameColumn('record_calls_next', 'record_calls')
    .execute();
}
