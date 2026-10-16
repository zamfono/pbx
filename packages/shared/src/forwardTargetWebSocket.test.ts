import { sql } from 'kysely';
import { expect, test } from 'vitest';

import { migratedTestDb } from './testDb.js';

// The webSocket target kind of forward_targets (§9.4 "WebSocket targets", §11.2).
test.each([
  [
    'a URL without a protocol',
    sql`INSERT INTO forward_targets (id, web_socket_url, web_socket_sample_rate) VALUES ('w1', 'wss://bot.example/a', 8000)`
  ],
  [
    'a protocol without a URL',
    sql`INSERT INTO forward_targets (id, external, web_socket_protocol, web_socket_sample_rate) VALUES ('w2', '+431', 'vonage', 16000)`
  ],
  [
    'a URL without a sample rate',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url) VALUES ('w3', 'vonage', 'wss://bot.example/a')`
  ],
  [
    'an unknown protocol',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate) VALUES ('w4', 'plivo', 'wss://bot.example/a', 8000)`
  ],
  [
    'an http URL',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate) VALUES ('w5', 'vonage', 'https://bot.example/a', 16000)`
  ],
  [
    'a URL that is only the scheme',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate) VALUES ('w6', 'vonage', 'wss://', 16000)`
  ],
  [
    'a URL over 2048 characters',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate) VALUES ('w7', 'vonage', ${`wss://${'a'.repeat(2043)}`}, 16000)`
  ],
  [
    'a sample rate no protocol speaks',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate) VALUES ('w8', 'vonage', 'wss://bot.example/a', 44100)`
  ],
  [
    'a twilio target at 16 kHz',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate) VALUES ('w9', 'twilio', 'wss://bot.example/a', 16000)`
  ],
  [
    'a webSocket target that is also external',
    sql`INSERT INTO forward_targets (id, external, web_socket_protocol, web_socket_url, web_socket_sample_rate) VALUES ('w10', '+431', 'vonage', 'wss://bot.example/a', 16000)`
  ]
])('a webSocket target refuses %s', async (label, statement) => {
  const db = await migratedTestDb();
  await expect(statement.execute(db)).rejects.toThrow(
    /CHECK constraint failed/u
  );
});

test.each([
  [
    'a twilio target, recording',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate, record_calls) VALUES ('ok1', 'twilio', 'wss://bot.example/media?token=a', 8000, 1)`
  ],
  [
    'a vonage target at 24 kHz over plain ws',
    sql`INSERT INTO forward_targets (id, web_socket_protocol, web_socket_url, web_socket_sample_rate) VALUES ('ok2', 'vonage', 'ws://10.0.0.5:8080/', 24000)`
  ]
])('a webSocket target takes %s', async (label, statement) => {
  const db = await migratedTestDb();
  await expect(statement.execute(db)).resolves.toBeDefined();
});

test('a mailbox target still may not record', async () => {
  const db = await migratedTestDb();
  await sql`INSERT INTO users (id, name, email, created_at) VALUES ('u1', 'A', 'a@x', 't')`.execute(
    db
  );
  await expect(
    sql`INSERT INTO forward_targets (id, mailbox_user_id, record_calls) VALUES ('r1', 'u1', 1)`.execute(
      db
    )
  ).rejects.toThrow(/CHECK constraint failed/u);
});
