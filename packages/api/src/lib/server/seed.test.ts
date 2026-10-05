import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi
} from 'vitest';

import { migratedTestDb } from '@zamfono/shared/testDb.js';

import { testKeyring } from '#testing/fixtures.js';

import { decrypt } from './secretbox.js';
import { seedIfEmpty } from './seed.js';
import type { SeedEnv } from './seedEnv.js';
import {
  MOH_NARROWBAND_EXT,
  MOH_TRACK_BASENAMES,
  MOH_WIDEBAND_EXT
} from './seedMoh.js';

const EXT_LENGTH_TWO = 2;

const silentLogger = pino({ level: 'silent' });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function tempMediaDir(): Promise<string> {
  return tempDir('zamfono-media-');
}

/** A source directory holding the wav and g722 variant of every bundled MoH track. */
async function mohSourceFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-moh-src-'));
  await Promise.all(
    MOH_TRACK_BASENAMES.flatMap(basename =>
      [MOH_NARROWBAND_EXT, MOH_WIDEBAND_EXT].map(ext =>
        writeFile(path.join(dir, `${basename}.${ext}`), `${basename}.${ext}`)
      )
    )
  );
  return dir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

let mohSourceDir = '';

beforeAll(async () => {
  mohSourceDir = await mohSourceFixture();
});

afterAll(() => rm(mohSourceDir, { recursive: true, force: true }));

function baseEnv(overrides: Partial<SeedEnv> = {}): SeedEnv {
  return {
    BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
    BOOTSTRAP_OWNER_NAME: 'Owner',
    BOOTSTRAP_OWNER_PASSWORD_HASH: '$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA',
    COMPANY_NAME: 'Acme GmbH',
    MAIN_DID: '+491234567',
    COUNTRY: 'DE',
    MOH_SOURCE_DIR: mohSourceDir,
    ...overrides
  };
}

describe('seedIfEmpty', () => {
  it('seeds an empty database from .env', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    const result = await seedIfEmpty(
      db,
      baseEnv(),
      testKeyring(),
      mediaDir,
      silentLogger
    );
    expect(result).toBe('seeded');

    const owner = await db
      .selectFrom('users')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(owner.role).toBe('owner');
    expect(owner.passwordHash).toBe('$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA');

    const settings = await db
      .selectFrom('settings')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(settings.companyName).toBe('Acme GmbH');
    expect(settings.country).toBe('DE');
    expect(settings.extLength).toBe(3);

    const did = await db
      .selectFrom('dids')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(did.number).toBe('+491234567');
    expect(settings.mainDidId).toBe(did.id);
    const target = await db
      .selectFrom('forwardTargets')
      .selectAll()
      .where('id', '=', did.targetId)
      .executeTakeFirstOrThrow();
    expect(target.userId).toBe(owner.id);

    const slots = await db
      .selectFrom('extensions')
      .select('ext')
      .where('isParkingSlot', '=', 1)
      .orderBy('ext')
      .execute();
    expect(slots.map(slot => slot.ext)).toEqual([
      '701',
      '702',
      '703',
      '704',
      '705',
      '706',
      '707',
      '708',
      '709'
    ]);

    const moh = await db
      .selectFrom('audioAssets')
      .selectAll()
      .where('kind', '=', 'moh')
      .execute();
    expect(moh).toHaveLength(5);
    expect(moh.every(asset => asset.uploadedBy === null)).toBe(true);
  });

  it('lays out each MoH asset the PJSIP renderer and storeAudio read (§10.2)', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await seedIfEmpty(db, baseEnv(), testKeyring(), mediaDir, silentLogger);
    const moh = await db
      .selectFrom('audioAssets')
      .selectAll()
      .where('kind', '=', 'moh')
      .execute();
    await Promise.all(
      moh.map(async asset => {
        // The row names the file it wrote to `prompts/` (storeAudio's own `<id>.wav` layout);
        // the class directory's basename stays the bundled track's own, since Asterisk's
        // `mode = files` plays every file in `directory` regardless of name.
        expect(asset.filename).toBe(`${asset.id}.${MOH_NARROWBAND_EXT}`);
        const classDir = path.join(mediaDir, 'prompts', 'moh', asset.id);
        const classFiles = await readdir(classDir);
        const basename = MOH_TRACK_BASENAMES.find(name =>
          classFiles.includes(`${name}.${MOH_NARROWBAND_EXT}`)
        );
        expect(basename).toBeDefined();
        const [narrowband, wideband, prompt] = await Promise.all([
          exists(path.join(classDir, `${basename}.${MOH_NARROWBAND_EXT}`)),
          exists(path.join(classDir, `${basename}.${MOH_WIDEBAND_EXT}`)),
          exists(path.join(mediaDir, 'prompts', asset.filename))
        ]);
        expect(narrowband).toBe(true);
        expect(wideband).toBe(true);
        expect(prompt).toBe(true);
      })
    );
  });

  it('refuses to seed when the hold-music source directory is absent', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    const missingSourceDir = path.join(
      await tempDir('zamfono-moh-missing-'),
      'does-not-exist'
    );

    // §6.3 "First boot" lists the five bundled `moh` assets among the rows first boot creates, and
    // the api image installs the opsound packages that carry them. A stack whose tracks are not
    // where the seed expects them is misbuilt, and says so rather than coming up without hold
    // music that nothing later restores.
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ MOH_SOURCE_DIR: missingSourceDir }),
        testKeyring(),
        mediaDir,
        pino({ level: 'silent' })
      )
    ).rejects.toThrow(/hold-music source directory/u);
  });

  it('seeds the settings row from the SMTP_* env', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    const kr = testKeyring();
    await seedIfEmpty(
      db,
      baseEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_SECURITY: 'starttls',
        SMTP_USER: 'relay-user',
        SMTP_PASSWORD: 'relay-secret',
        MAIL_FROM: 'no-reply@example.com'
      }),
      kr,
      mediaDir,
      silentLogger
    );
    const settings = await db
      .selectFrom('settings')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(settings.smtpHost).toBe('smtp.example.com');
    expect(settings.smtpPort).toBe(587);
    expect(settings.smtpSecurity).toBe('starttls');
    expect(settings.smtpUser).toBe('relay-user');
    expect(settings.mailFrom).toBe('no-reply@example.com');
    if (settings.smtpPasswordEnc === null) {
      throw new Error('expected smtp_password_enc to be set');
    }
    expect(
      decrypt(
        kr,
        'settings.smtpPasswordEnc',
        settings.smtpPasswordEnc
      ).toString('utf8')
    ).toBe('relay-secret');
  });

  it('gives the owner the highest extension less one, leaving all-nines free', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await seedIfEmpty(db, baseEnv(), testKeyring(), mediaDir, silentLogger);
    const owner = await db
      .selectFrom('users')
      .select('id')
      .executeTakeFirstOrThrow();
    // Every live user owns exactly one extension (§11.2), and `GET /users` reports it, so the
    // first user is dialable and readable over REST without any further configuration.
    const extension = await db
      .selectFrom('extensions')
      .select(['ext', 'isParkingSlot'])
      .where('userId', '=', owner.id)
      .executeTakeFirstOrThrow();
    expect(extension.ext).toBe('998');
    expect(extension.isParkingSlot).toBe(0);
  });

  it('numbers the owner `98` for a two-digit extension length', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await seedIfEmpty(
      db,
      baseEnv({ EXT_LENGTH: String(EXT_LENGTH_TWO) }),
      testKeyring(),
      mediaDir,
      silentLogger
    );
    const extension = await db
      .selectFrom('extensions')
      .select('ext')
      .where('isParkingSlot', '=', 0)
      .executeTakeFirstOrThrow();
    expect(extension.ext).toBe('98');
  });

  it('numbers parking slots 71 to 79 for a two-digit extension length', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await seedIfEmpty(
      db,
      baseEnv({ EXT_LENGTH: String(EXT_LENGTH_TWO) }),
      testKeyring(),
      mediaDir,
      silentLogger
    );
    const slots = await db
      .selectFrom('extensions')
      .select('ext')
      .where('isParkingSlot', '=', 1)
      .orderBy('ext')
      .execute();
    expect(slots.map(slot => slot.ext)).toEqual([
      '71',
      '72',
      '73',
      '74',
      '75',
      '76',
      '77',
      '78',
      '79'
    ]);
  });

  it('rejects a non-numeric EXT_LENGTH', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ EXT_LENGTH: 'abc' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/EXT_LENGTH/u);
  });

  it('rejects an EXT_LENGTH below the floor of 2', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ EXT_LENGTH: '1' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/EXT_LENGTH/u);
  });

  it('rejects an SMTP_SECURITY other than tls or starttls', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ SMTP_SECURITY: 'none' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/SMTP_SECURITY/u);
  });

  it('seeds smtp_security tls when SMTP_SECURITY is unset', async () => {
    const db = await migratedTestDb();
    await seedIfEmpty(
      db,
      baseEnv(),
      testKeyring(),
      await tempMediaDir(),
      silentLogger
    );
    const settings = await db
      .selectFrom('settings')
      .select('smtpSecurity')
      .executeTakeFirstOrThrow();
    expect(settings.smtpSecurity).toBe('tls');
  });

  it('rejects a non-numeric SMTP_PORT', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ SMTP_PORT: 'abc' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/SMTP_PORT/u);
  });

  it('rejects an out-of-range SMTP_PORT', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ SMTP_PORT: '70000' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/SMTP_PORT/u);
  });

  it('rejects a MAIN_DID that is not E.164', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ MAIN_DID: '01234567' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/MAIN_DID/u);
  });

  // §6.3 "First boot": a malformed seed value stops `api` before it serves a request; `UK` is
  // not ISO 3166-1 (`GB` is), so it has no calling code and every normalization would throw.
  it('throws for a COUNTRY that names no calling code, and seeds nothing', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ COUNTRY: 'UK' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/COUNTRY/u);
    const users = await db.selectFrom('users').select('id').execute();
    expect(users).toHaveLength(0);
  });

  it('skips a database that already holds a user', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    const kr = testKeyring();
    await seedIfEmpty(db, baseEnv(), kr, mediaDir, silentLogger);
    const second = await seedIfEmpty(db, baseEnv(), kr, mediaDir, silentLogger);
    expect(second).toBe('skipped');
  });

  it('seeds the default backup target once: a later start brings back none the purge removed', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    const kr = testKeyring();
    const env = baseEnv({ BACKUP_PASSWORD: 'from-env' });
    await seedIfEmpty(db, env, kr, mediaDir, silentLogger);
    expect(
      await db.selectFrom('backupTargets').select('id').execute()
    ).toHaveLength(1);
    await db.deleteFrom('backupTargets').execute();
    await seedIfEmpty(db, env, kr, mediaDir, silentLogger);
    expect(await db.selectFrom('backupTargets').select('id').execute()).toEqual(
      []
    );
  });

  it('falls back to ["112"] for a country without an entry', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await seedIfEmpty(
      db,
      baseEnv({ COUNTRY: 'US' }),
      testKeyring(),
      mediaDir,
      silentLogger
    );
    const settings = await db
      .selectFrom('settings')
      .select('emergencyNumbersJson')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(settings.emergencyNumbersJson)).toEqual(['112']);
  });

  it('logs a warning naming the country when it has no emergency-number entry (§6.3)', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    const logger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(logger, 'warn');
    await seedIfEmpty(
      db,
      baseEnv({ COUNTRY: 'US' }),
      testKeyring(),
      mediaDir,
      logger
    );
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('US')
    );
  });

  it('throws when SMTP_HOST is set without MAIL_FROM', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ SMTP_HOST: 'smtp.example.com' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/MAIL_FROM/u);
  });

  it('throws when SMTP_HOST is set with a malformed MAIL_FROM', async () => {
    const db = await migratedTestDb();
    const mediaDir = await tempMediaDir();
    await expect(
      seedIfEmpty(
        db,
        baseEnv({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'not-an-address' }),
        testKeyring(),
        mediaDir,
        silentLogger
      )
    ).rejects.toThrow(/MAIL_FROM/u);
  });

  it.each([
    ['missing', undefined],
    ['not an Argon2id PHC string', '=19=65536,p=4,t=3'],
    ['an Argon2i one', '$argon2i$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA']
  ])(
    'refuses to seed, even with a mail relay, with the password hash %s',
    async (_case, hash) => {
      const db = await migratedTestDb();
      const mediaDir = await tempMediaDir();
      const env = baseEnv({
        SMTP_HOST: 'smtp.example.com',
        MAIL_FROM: 'no-reply@example.com',
        BOOTSTRAP_OWNER_PASSWORD_HASH: hash
      });
      await expect(
        seedIfEmpty(db, env, testKeyring(), mediaDir, silentLogger)
      ).rejects.toThrow(/BOOTSTRAP_OWNER_PASSWORD_HASH/u);

      const owner = await db
        .selectFrom('users')
        .select('id')
        .executeTakeFirst();
      expect(owner).toBeUndefined();
    }
  );
});
