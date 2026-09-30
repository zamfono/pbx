import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// call_qos.rx_packets and tx_packets (§7 level `qos`, §11.2): the packets each leg's RTP instance
// received from and sent to the peer. SQLite's `ADD COLUMN` takes a nullable column with a CHECK,
// so no rebuild is needed. An existing row's counts were never recorded and stay NULL, which the
// column reads as "not counted", never as 0.

export async function up(db: Db): Promise<void> {
  await db.schema
    .alterTable('call_qos')
    .addColumn('rx_packets', 'integer', col => col.check(sql`rx_packets >= 0`))
    .execute();
  await db.schema
    .alterTable('call_qos')
    .addColumn('tx_packets', 'integer', col => col.check(sql`tx_packets >= 0`))
    .execute();
}

export async function down(db: Db): Promise<void> {
  await db.schema.alterTable('call_qos').dropColumn('tx_packets').execute();
  await db.schema.alterTable('call_qos').dropColumn('rx_packets').execute();
}
