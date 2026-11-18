import { sql, type Kysely } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations are frozen in time; typing against the live schema would break earlier migrations once it evolves
type Db = Kysely<any>;

// How long a request waits for its answer unless told otherwise, as a webhook's delivery.
const DEFAULT_TIMEOUT_S = 5;

// HTTP requests of a call flow (§10.1 step 7 "HTTP requests", §11.2): a node that sends a request
// while the call waits, keeps the JSON it answers under its name, and sends the call on to its
// target, or to its error target when the request fails. A forward target of kind `httpRequest`
// names one (`forward_targets.http_request_id`).
async function createHttpRequestsTable(db: Db): Promise<void> {
  await db.schema
    .createTable('http_requests')
    .addColumn('id', 'text', col => col.primaryKey().notNull())
    .addColumn('name', 'text', col => col.notNull())
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
    .addColumn('secret_enc', 'blob')
    .addColumn('timeout_s', 'integer', col =>
      col
        .notNull()
        .defaultTo(DEFAULT_TIMEOUT_S)
        .check(sql`timeout_s between 1 and 86400`)
    )
    .addColumn('target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('error_target_id', 'text', col =>
      col.notNull().references('forward_targets.id').onDelete('restrict')
    )
    .addColumn('created_at', 'text', col => col.notNull())
    .addColumn('deleted_at', 'text')
    .addCheckConstraint(
      'http_requests_body',
      sql`(body is null) = (content_type is null) and (body is null or method not in ('GET','DELETE'))`
    )
    .execute();
  await db.schema
    .createIndex('http_requests_name')
    .on('http_requests')
    .unique()
    .column('name')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute();
}

// forward_targets — the kind `httpRequest`.
async function addForwardTargetHttpRequest(db: Db): Promise<void> {
  await db.schema
    .alterTable('forward_targets')
    .addColumn('http_request_id', 'text', col =>
      col.references('http_requests.id').onDelete('restrict')
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
             (menu_id is not null) + (decision_id is not null) + (extension is not null) +
             (http_request_id is not null) <= 1`
    )
    .execute();
}

export async function up(db: Db): Promise<void> {
  await createHttpRequestsTable(db);
  await addForwardTargetHttpRequest(db);
}
