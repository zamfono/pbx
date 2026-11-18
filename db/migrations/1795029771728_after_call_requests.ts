import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// after_call_requests — the request an `external`, `sip` or `webSocket` forward target sends
// after each of its attempts (§10.6 "After-call requests", §11.2): the HTTP request block, which
// recordings' tokens it carries, and its delivery health, as a webhook's. The row is its target's
// own: a write of the target updates it in place, and it goes with the target.
async function createAfterCallRequestsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('after_call_requests')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('forward_target_id', 'text', col =>
      col
        .notNull()
        .unique()
        .references('forward_targets.id')
        .onDelete('cascade')
    )
    .addColumn('method', 'text', col =>
      col.notNull().check(sql`method in ('GET','POST','PUT','PATCH','DELETE')`)
    )
    .addColumn('url', 'text', col => col.notNull())
    .addColumn('headers_json', 'text', col => col.notNull().defaultTo('[]'))
    .addColumn('secret_headers_enc', 'blob')
    .addColumn('body', 'text')
    .addColumn('content_type', 'text', col =>
      col.check(
        sql`content_type in ('application/json','application/x-www-form-urlencoded','text/plain')`
      )
    )
    .addColumn('secret_enc', 'blob', col => col.notNull())
    .addColumn('recording_download', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`recording_download in (0,1)`)
    )
    .addColumn('recording_delete', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`recording_delete in (0,1)`)
    )
    .addColumn('last_status', 'text', col =>
      col.check(sql`last_status in ('ok','failing')`)
    )
    .addColumn('last_delivery_at', 'text')
    .addColumn('last_error', 'text')
    .addColumn('last_error_at', 'text')
    .addColumn('failing_since', 'text')
    .addColumn('failed_deliveries', 'integer', col =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`failed_deliveries >= 0`)
    )
    .addColumn('last_logged_at', 'text')
    .addCheckConstraint(
      'after_call_requests_body',
      sql`(body is null) = (content_type is null) and (body is null or method not in ('GET','DELETE'))`
    )
    .execute();
}

// webhook_deliveries — the outbox also holds after-call requests on their way: a row names its
// webhook or its after-call request, never both, and goes with either.
async function deliveriesOfAfterCallRequests(db: Db): Promise<void> {
  await sql`alter table webhook_deliveries alter column webhook_id drop not null`.execute(
    db
  );
  await db.schema
    .alterTable('webhook_deliveries')
    .addColumn('after_call_request_id', 'text', col =>
      col.references('after_call_requests.id').onDelete('cascade')
    )
    .execute();
  await db.schema
    .createIndex('webhook_deliveries_after_call_request')
    .on('webhook_deliveries')
    .column('after_call_request_id')
    .execute();
  await db.schema
    .alterTable('webhook_deliveries')
    .addCheckConstraint(
      'webhook_deliveries_one_owner',
      sql`(webhook_id is null) <> (after_call_request_id is null)`
    )
    .execute();
}

export async function up(db: Db): Promise<void> {
  await createAfterCallRequestsTable(db);
  await deliveriesOfAfterCallRequests(db);
}
