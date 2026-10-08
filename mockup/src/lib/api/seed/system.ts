/**
 * Seed: tenant settings, system state, security, integrations, backups, mail templates and the
 * audit history.
 */
import { now as demoNow } from '#lib/clock.svelte.js';

import { seedId } from '../ids';
import type {
  AuditEntry,
  BackupRun,
  BackupTarget,
  Language,
  MailTemplate,
  RingotelProvisioning,
  Settings,
  SipAllowlistEntry,
  SipBan,
  SystemInfo,
  Webhook
} from '../types';
import { AUDIO, BACKUP, DID, OOO, RG, TRUNK, U, WEBHOOK } from './ids';
import { at, daysAgo, minutesAgo, plus } from './time';

export function seedSettings(): Settings {
  return {
    companyName: 'Brandt & Partner Steuerberatung',
    mainDidId: DID.main,
    country: 'DE',
    timezone: 'Europe/Berlin',
    language: 'de',
    smtpHost: 'smtp.ionos.de',
    smtpPort: 465,
    smtpSecurity: 'tls',
    smtpUser: 'telefon@brandt-partner.de',
    smtpPasswordSet: true,
    mailFrom: 'Brandt & Partner Telefonanlage <telefon@brandt-partner.de>',
    smtpCheckIntervalS: 900,
    extLength: 3,
    emergencyNumbers: ['110', '112'],
    featureCodes: {
      pickup: '*8',
      dndOn: '*90',
      dndOff: '*91',
      mailbox: '*95',
      ownVoicemail: '*96',
      deposit: '*97',
      addParty: '*5',
      clirOn: '#31#',
      clirOff: '*31#',
      park: '*70'
    },
    fallbackTarget: { kind: 'ringGroup', ringGroupId: RG.empfang },
    codecs: ['opus', 'g722', 'alaw'],
    clir: false,
    rejectAnonymous: false,
    holdMohAudioId: AUDIO.mohLounge,
    voicemailMaxS: 180,
    parkingTimeoutS: 300,
    callLogLevel: 'events',
    recordingRetentionDays: 90,
    softDeleteRetentionDays: 30,
    auditRetentionDays: 730,
    sipBanFailures: 10,
    sipBanWindowS: 3600,
    sipBanSuccessExemptS: 86400,
    sipBanLookbackS: 2592000,
    sipBanSteps: [86400, 31536000, null],
    backupCron: '0 3 * * *',
    tlsReloadHour: 4,
    autoUpdate: false,
    mfaRequiredForAll: false,
    ssoProvider: 'microsoft',
    ssoLabel: null,
    ssoIssuer:
      'https://login.microsoftonline.com/7c1d4b2e-58a1-4f0e-9b6c-2d3e4f5a6b7c/v2.0',
    ssoClientId: '3f9a2c71-0d4e-4b8a-a1f2-6c7d8e9f0a1b',
    ssoTenantId: '7c1d4b2e-58a1-4f0e-9b6c-2d3e4f5a6b7c',
    ssoAllowedDomain: 'brandt-partner.de',
    ssoClientSecretSet: true,
    ringotelMaxRegs: 3,
    ringotelApiTokenSet: true,
    ringotelOrgId: '61a3f0c2b7e4d9a1c8f5e2b0',
    ringotelBranchId: '61a3f0c2b7e4d9a1c8f5e2b1'
  };
}

export function seedSystem(): SystemInfo {
  return {
    api: {
      version: '0.4.1',
      revision: '29a5795e',
      display: '0.4.1 (29a5795)',
      startedAt: daysAgo(6)
    },
    core: {
      version: '0.4.1',
      revision: '29a5795e',
      display: '0.4.1 (29a5795)',
      startedAt: daysAgo(6),
      asteriskStartedAt: daysAgo(6)
    },
    update: {
      current: '0.4.1',
      latest: {
        version: '0.5.0',
        url: 'https://github.com/zamfono/pbx/releases/tag/v0.5.0',
        publishedAt: daysAgo(2)
      },
      updatable: true,
      breaking: false,
      last: {
        state: 'succeeded',
        from: '0.4.0',
        to: '0.4.1',
        startedAt: daysAgo(6),
        finishedAt: plus(daysAgo(6), 94),
        trigger: 'manual',
        by: 'Lea Brandt'
      }
    },
    autoUpdate: { enabled: false, failed: null },
    ringotel: { profilePending: false, rosterPending: false },
    mail: { ok: true, at: minutesAgo(11), error: null },
    skippedConfigRows: [],
    stack: { domain: 'tel.brandt-partner.de', ipv4: '203.0.113.24' },
    maintenance: false
  };
}

export function seedRingotel(): RingotelProvisioning {
  return {
    orgId: '61a3f0c2b7e4d9a1c8f5e2b0',
    branchId: '61a3f0c2b7e4d9a1c8f5e2b1',
    domain: 'brandtpartner',
    region: 'eu-central',
    packageId: 2
  };
}

export function seedSipBans(): SipBan[] {
  return [
    {
      id: seedId('ban:1'),
      address: '185.243.5.117',
      reason: 'authFailures',
      failures: 214,
      step: 2,
      createdAt: daysAgo(9),
      expiresAt: null,
      liftedAt: null
    },
    {
      id: seedId('ban:2'),
      address: '45.134.26.89',
      reason: 'authFailures',
      failures: 37,
      step: 1,
      createdAt: at(0, 4, 12),
      expiresAt: plus(at(0, 4, 12), 86400),
      liftedAt: null
    },
    {
      id: seedId('ban:3'),
      address: '198.51.100.44',
      reason: 'authFailures',
      failures: 12,
      step: 1,
      createdAt: daysAgo(15),
      expiresAt: daysAgo(14),
      liftedAt: daysAgo(15)
    }
  ];
}

export function seedSipAllowlist(): SipAllowlistEntry[] {
  return [
    {
      id: seedId('allow:office'),
      address: '198.51.100.17',
      label: 'Büro München (Glasfaser)',
      createdAt: daysAgo(300),
      deletedAt: null
    },
    {
      id: seedId('allow:vpn'),
      address: '10.20.0.0/24',
      label: 'Büro-LAN Konferenzraum',
      createdAt: daysAgo(200),
      deletedAt: null
    }
  ];
}

export function seedWebhooks(): Webhook[] {
  return [
    {
      id: WEBHOOK.crm,
      url: 'https://crm.brandt-partner.de/hooks/zamfono',
      secretSet: true,
      eventTypes: ['call.state', 'voicemail.new', 'history.appended'],
      active: true,
      lastStatus: 'ok',
      lastDeliveryAt: minutesAgo(3),
      failingSince: null,
      failedDeliveries: 0,
      lastError: null,
      lastErrorAt: daysAgo(12),
      createdAt: daysAgo(120),
      deletedAt: null
    }
  ];
}

export function seedBackupTargets(): BackupTarget[] {
  return [
    {
      id: BACKUP.nas,
      kind: 'sftp',
      label: 'NAS im Büro',
      params: {
        host: 'nas.brandt-partner.de',
        path: '/volume1/backup/zamfono'
      },
      secretSet: true,
      enabled: true,
      createdAt: daysAgo(300),
      deletedAt: null
    },
    {
      id: BACKUP.s3,
      kind: 's3',
      label: 'Offsite (S3, Frankfurt)',
      params: {
        endpoint: 's3.eu-central-2.wasabisys.com',
        bucket: 'brandt-partner-pbx',
        path: 'zamfono',
        forget: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 }
      },
      secretSet: true,
      enabled: true,
      createdAt: daysAgo(280),
      deletedAt: null
    }
  ];
}

const MIB = 1_048_576;

export function seedBackupRuns(): BackupRun[] {
  const runs: BackupRun[] = [];
  for (let day = 7; day >= 0; day -= 1) {
    for (const target of [BACKUP.nas, BACKUP.s3]) {
      const startedAt = at(
        day,
        3,
        target === BACKUP.nas ? 0 : 0,
        target === BACKUP.nas ? 2 : 9
      );
      if (new Date(startedAt).getTime() > demoNow()) {
        continue;
      }
      const failed = day === 3 && target === BACKUP.nas;
      runs.push({
        id: seedId(`backupRun:${target}:${day}`),
        targetId: target,
        status: failed ? 'failed' : 'ok',
        trigger: 'schedule',
        startedAt,
        finishedAt: plus(startedAt, failed ? 31 : 48 + day),
        bytesAdded: failed ? null : Math.round((2.1 + day * 0.3) * MIB),
        bytesTotal: failed ? null : Math.round((412 + (7 - day) * 2.4) * MIB),
        snapshotId: failed
          ? null
          : seedId(`snapshot:${target}:${day}`).slice(0, 8),
        error: failed
          ? 'sftp: dial tcp nas.brandt-partner.de:22: connect: connection refused'
          : null
      });
    }
  }
  return runs.reverse();
}

/**
 * The tenant's mail-template overrides; every other kind and language uses the shipped text
 * (`components/system/shippedMailTemplates.ts`). Brandt & Partner rewrote the German voicemail mail.
 */
export function seedMailTemplates(): MailTemplate[] {
  return [
    {
      kind: 'voicemail',
      language: 'de',
      subject: 'Brandt & Partner: Nachricht von {{callerNumber}}',
      bodyText:
        'Hallo {{recipientName}},\n\n{{#if callerName}}{{callerName}} ({{callerNumber}}){{else}}{{callerNumber}}{{/if}} hat am {{date receivedAt}} eine Nachricht für {{mailboxName}} hinterlassen ({{durationS}} Sekunden). Bitte innerhalb eines Werktags zurückrufen.\n\nDie Aufnahme hängt an.',
      bodyHtml: null,
      overridden: true
    }
  ];
}

export function seedAudit(): AuditEntry[] {
  const entry = (
    key: string,
    createdAt: string,
    fields: Partial<AuditEntry> &
      Pick<AuditEntry, 'operation' | 'entityKind' | 'entityId'>
  ): AuditEntry => ({
    id: seedId(`audit:${key}`, new Date(createdAt).getTime()),
    actorUserId: U.jonas,
    actorUserName: 'Jonas Weber',
    channel: 'ui',
    clientId: null,
    clientName: null,
    changes: [],
    undoable: true,
    revertsId: null,
    undoneAt: null,
    revert: [],
    createdAt,
    ...fields
  });
  return [
    entry('ooo-felix', daysAgo(12), {
      actorUserId: U.felix,
      actorUserName: 'Dr. Felix Hartmann',
      channel: 'mcp',
      clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
      clientName: 'Claude Code',
      operation: 'ooo.create',
      entityKind: 'oooRule',
      entityId: OOO.felixVacation,
      changes: [
        { field: 'scope', from: null, to: { kind: 'user', id: U.felix } },
        { field: 'target', from: null, to: { kind: 'user', userId: U.daniel } }
      ]
    }),
    entry('rg-support', daysAgo(5), {
      operation: 'ringGroups.update',
      entityKind: 'ringGroup',
      entityId: RG.support,
      changes: [{ field: 'ringTotalS', from: 60, to: 45 }]
    }),
    entry('rg-support-log', daysAgo(3), {
      operation: 'ringGroups.update',
      entityKind: 'ringGroup',
      entityId: RG.support,
      changes: [
        { field: 'logLevel', from: null, to: 'qos' },
        { field: 'logLevelExpiresAt', from: null, to: daysAgo(-4) }
      ]
    }),
    entry('trunk-rereg', at(1, 3, 14), {
      operation: 'trunks.reregister',
      entityKind: 'trunk',
      entityId: TRUNK.nordwind,
      undoable: false,
      pure: true
    }),
    entry('settings-retention', daysAgo(20), {
      actorUserId: U.lea,
      actorUserName: 'Lea Brandt',
      operation: 'settings.update',
      entityKind: 'settings',
      entityId: 'settings',
      changes: [{ field: 'auditRetentionDays', from: null, to: 730 }]
    }),
    entry('user-nina', daysAgo(30), {
      operation: 'users.create',
      entityKind: 'user',
      entityId: U.nina,
      changes: [
        { field: 'name', from: null, to: 'Nina Schreiber' },
        { field: 'extension', from: null, to: '114' },
        { field: 'role', from: null, to: 'user' }
      ]
    }),
    entry('reveal', daysAgo(8), {
      operation: 'devices.revealCredentials',
      entityKind: 'device',
      entityId: seedId(`device:${U.empfang}:Yealink T58 Empfang`),
      undoable: false,
      pure: true
    }),
    entry('webhook', daysAgo(120), {
      actorUserId: U.lea,
      actorUserName: 'Lea Brandt',
      operation: 'webhooks.create',
      entityKind: 'webhook',
      entityId: WEBHOOK.crm,
      changes: [
        {
          field: 'url',
          from: null,
          to: 'https://crm.brandt-partner.de/hooks/zamfono'
        }
      ],
      undoable: false
    }),
    entry('ringotel-push', daysAgo(30), {
      actorUserId: 'system',
      actorUserName: 'Zamfono',
      channel: 'job',
      operation: 'ringotel.push',
      entityKind: 'device',
      entityId: seedId(`device:${U.nina}:Ringotel App`),
      changes: [{ field: 'outcome', from: null, to: 'ok' }],
      undoable: false,
      pure: true
    })
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
