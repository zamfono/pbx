import { defineFields } from '../registry';

/** `settings.update` (§11.4); owner-only fields as an admin sees them (design §3.2). */
defineFields({
  entity: 'settings',
  ops: ['settings.update'],
  fields: [
    { key: 'companyName', tier: 'basic' },
    { key: 'mainDidId', tier: 'basic' },
    { key: 'country', tier: 'advanced' },
    { key: 'timezone', tier: 'advanced' },
    { key: 'language', tier: 'basic' },
    { key: 'extLength', tier: 'advanced', readOnly: true },
    { key: 'smtpHost', tier: 'basic', owner: 'display' },
    { key: 'smtpPort', tier: 'advanced', owner: 'display' },
    { key: 'smtpSecurity', tier: 'advanced', owner: 'display' },
    { key: 'smtpUser', tier: 'basic', owner: 'display' },
    { key: 'smtpPassword', tier: 'basic', owner: 'hidden' },
    { key: 'mailFrom', tier: 'basic', owner: 'display' },
    { key: 'smtpCheckIntervalS', tier: 'expert', owner: 'hidden' },
    { key: 'emergencyNumbers', tier: 'advanced', owner: 'display' },
    { key: 'featureCodes', tier: 'advanced' },
    { key: 'fallbackTarget', tier: 'advanced' },
    { key: 'codecs', tier: 'expert' },
    { key: 'clir', tier: 'basic' },
    { key: 'rejectAnonymous', tier: 'basic' },
    { key: 'holdMohAudioId', tier: 'basic' },
    { key: 'voicemailMaxS', tier: 'advanced' },
    { key: 'parkingTimeoutS', tier: 'advanced' },
    { key: 'callLogLevel', tier: 'expert' },
    { key: 'recordingRetentionDays', tier: 'advanced' },
    { key: 'softDeleteRetentionDays', tier: 'advanced' },
    { key: 'auditRetentionDays', tier: 'advanced', owner: 'display' },
    { key: 'sipBanFailures', tier: 'expert' },
    { key: 'sipBanWindowS', tier: 'expert' },
    { key: 'sipBanSuccessExemptS', tier: 'expert' },
    { key: 'sipBanLookbackS', tier: 'expert' },
    { key: 'sipBanSteps', tier: 'expert' },
    { key: 'backupCron', tier: 'advanced' },
    { key: 'tlsReloadHour', tier: 'expert' },
    { key: 'autoUpdate', tier: 'basic', owner: 'display' },
    { key: 'mfaRequiredForAll', tier: 'basic', owner: 'display' },
    { key: 'ssoProvider', tier: 'basic', owner: 'display' },
    { key: 'ssoLabel', tier: 'advanced', owner: 'display' },
    { key: 'ssoIssuer', tier: 'advanced', owner: 'hidden' },
    { key: 'ssoClientId', tier: 'advanced', owner: 'hidden' },
    { key: 'ssoTenantId', tier: 'advanced', owner: 'hidden' },
    { key: 'ssoAllowedDomain', tier: 'basic', owner: 'display' },
    { key: 'ssoClientSecret', tier: 'advanced', owner: 'hidden' },
    { key: 'ringotelMaxRegs', tier: 'advanced', owner: 'display' },
    { key: 'ringotelApiToken', tier: 'advanced', owner: 'hidden' }
  ]
});

/** `provisioning.ringotelSetup` / `ringotelAdopt` (§10.4): the Ringotel page, owners only. */
defineFields({
  entity: 'ringotel',
  ops: ['provisioning.ringotelSetup', 'provisioning.ringotelAdopt'],
  fields: [
    { key: 'domain', tier: 'basic', owner: 'hidden' },
    { key: 'region', tier: 'basic', owner: 'hidden' },
    { key: 'packageid', tier: 'basic', owner: 'hidden' },
    { key: 'orgId', tier: 'basic', owner: 'hidden' },
    { key: 'branchId', tier: 'advanced', owner: 'hidden' }
  ],
  notFields: ['confirm']
});

/** `system.update` (§6.3): the release to update to; left out, the latest. */
defineFields({
  entity: 'systemUpdate',
  ops: ['system.update'],
  fields: [{ key: 'version', tier: 'expert', owner: 'hidden' }],
  notFields: ['confirm']
});
