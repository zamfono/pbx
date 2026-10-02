#!/usr/bin/env node
// Prints the Argon2id PHC string that `BOOTSTRAP_OWNER_PASSWORD_HASH` takes verbatim (spec §6.3
// "First boot"), using the same `argon2.hash` defaults as every other password the stack stores.
// The api image ships it at /app/hash-password.mjs, so a deployment generates the owner's hash
// in one line:
//
//   read -rs PW && printf '%s' "$PW" | docker compose run --rm --no-deps -T api \
//     node hash-password.mjs
//
// The password arrives on stdin, which keeps it out of the shell history and out of the
// process list that every user on the host can read.
import { readFileSync } from 'node:fs';
import argon2 from 'argon2';

const NO_PASSWORD_EXIT_CODE = 1;
const STDIN_FD = 0;

// File descriptor 0 reads to EOF in one call and is typed as a string, so the password needs no
// stream assembly. An interactive terminal sends EOF on Ctrl-D.
const password = readFileSync(STDIN_FD, 'utf8').replace(/\r?\n$/u, '');
if (password === '') {
  console.error('hash-password: no password on stdin');
  process.exitCode = NO_PASSWORD_EXIT_CODE;
} else {
  console.log(await argon2.hash(password));
}
