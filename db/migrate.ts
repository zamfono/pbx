// The migrate image's entry point (spec §6.3 "Migrations"): runs `npm run deploy` (`kysely migrate
// latest`) against the `db` volume and exits 0 once every migration is applied. A database file
// that is briefly locked by another process is retried five times at 5 s intervals; a migration
// that fails on its own merits exits 1 at once, so a broken release stops the deployment without
// running its failing migration again. Node runs this file directly (type stripping), so it
// imports nothing but Node's own modules.
import { spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;
// better-sqlite3's messages for SQLITE_BUSY and SQLITE_LOCKED, and the codes themselves.
const LOCKED_PATTERN =
  /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/u;

type Outcome = { code: number | null; output: string };

/** One `npm run deploy`, its output streamed through and kept for the lock check. */
async function deploy(): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'deploy'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code, output });
    });
  });
}

/** Deploys from `attempt` on, retrying only while the database file is locked. */
async function migrate(attempt: number): Promise<number> {
  const { code, output } = await deploy();
  if (code === 0) {
    return 0;
  }
  if (!LOCKED_PATTERN.test(output)) {
    console.error('migration failed; not retrying');
    return 1;
  }
  if (attempt === ATTEMPTS) {
    console.error(`database still locked after ${String(ATTEMPTS)} attempts`);
    return 1;
  }
  console.error(
    `migration attempt ${String(attempt)} found the database locked; retrying in 5s`
  );
  await sleep(RETRY_DELAY_MS);
  return migrate(attempt + 1);
}

process.exitCode = await migrate(1);
