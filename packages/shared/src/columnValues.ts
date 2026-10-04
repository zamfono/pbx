/**
 * The values of the CHECK-constrained text columns (§11.2). `generated/db.d.ts` types each such
 * column by these unions (`kysely-generate`'s `overrides` in `package.json`), so a row read through
 * Kysely carries them; the lists serve the operations' input schemas.
 */

/** `users.role` (§5.3), most to least privileged. */
export const USER_ROLES = ['owner', 'admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** `mail_templates.kind` (§10.2 "Templates"): the mails `api` renders. */
export const MAIL_KINDS = [
  'voicemail',
  'missedCall',
  'setup',
  'reset',
  'updateFailed',
  'breakingUpdate'
] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/** `users.log_level`, `trunks.log_level` and `ring_groups.log_level` (§7): an override only
 * raises a call's level, so `none` belongs to the tenant default alone. */
export const LOG_LEVEL_OVERRIDES = ['events', 'qos', 'sip'] as const;
export type LogLevelOverride = (typeof LOG_LEVEL_OVERRIDES)[number];

/** `settings.call_log_level` (§7): the tenant default level. */
export const CALL_LOG_LEVELS = ['none', ...LOG_LEVEL_OVERRIDES] as const;
export type CallLogLevel = (typeof CALL_LOG_LEVELS)[number];

/** `devices.kind`. */
export const DEVICE_KINDS = ['manual', 'ringotel'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** `devices.transport`: TLS, or the stack's plain SIP transports. */
export const DEVICE_TRANSPORTS = ['tls', 'plain'] as const;
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[number];

/** `trunks.transport`. */
export const TRUNK_TRANSPORTS = ['udp', 'tcp', 'tls'] as const;
export type TrunkTransport = (typeof TRUNK_TRANSPORTS)[number];

/** `trunks.auth_mode`. */
export const TRUNK_AUTH_MODES = ['registration', 'ip'] as const;
export type TrunkAuthMode = (typeof TRUNK_AUTH_MODES)[number];

/** `trunks.inbound_number_format` and `trunks.caller_id_format`. */
export const NUMBER_FORMATS = ['e164', 'national'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];

/** `trunks.caller_id_header`. */
export const CALLERID_HEADERS = ['from', 'pai', 'both'] as const;
export type CallerIdHeader = (typeof CALLERID_HEADERS)[number];

/** `trunks.diversion` (§9.4 "Forwarded calls"): the `Diversion` a forwarded leg over the trunk
 * carries, none, the newest forward hop's or every hop's; `off` for a new trunk. */
export const DIVERSION_POLICIES = ['off', 'last', 'all'] as const;
export type DiversionPolicy = (typeof DIVERSION_POLICIES)[number];

/** `trunk_hosts.direction` (§9.4 "Hosts"). */
export const HOST_DIRECTIONS = ['both', 'outbound', 'inbound'] as const;
export type HostDirection = (typeof HOST_DIRECTIONS)[number];

/** `ring_groups.strategy`. */
export const RING_STRATEGIES = [
  'simultaneous',
  'sequential',
  'random'
] as const;
export type RingStrategy = (typeof RING_STRATEGIES)[number];

/** `user_forward_rules.condition`: the classic CFU/CFB/CFNR conditions plus presence-aware ones. */
export const USER_FORWARD_CONDITIONS = [
  'unconditional',
  'busy',
  'noAnswer',
  'dnd',
  'offline'
] as const;
export type UserForwardCondition = (typeof USER_FORWARD_CONDITIONS)[number];

/** `ring_group_forward_rules.condition`. */
export const RING_GROUP_FORWARD_CONDITIONS = [
  'unanswered',
  'unavailable'
] as const;
export type RingGroupForwardCondition =
  (typeof RING_GROUP_FORWARD_CONDITIONS)[number];

/** `settings.language` and `mail_templates.language`: the six tenant languages (§9.1, §10.2). */
export const LANGUAGES = ['de', 'en', 'es', 'fr', 'it', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

/** `settings.smtp_security`. */
export const SMTP_SECURITIES = ['tls', 'starttls'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

/** `settings.sso_provider`. */
export const SSO_PROVIDERS = ['microsoft', 'google', 'oidc'] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

/** `audio_assets.kind`. */
export const AUDIO_KINDS = [
  'greeting',
  'moh',
  'vmGreeting',
  'announcement'
] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

/** `oauth_clients.kind`. */
export type OAuthClientKind = 'metadata' | 'cimd';

/** `tokens.kind`. */
export type TokenKind = 'refresh' | 'reset';

/** `webhooks.last_status`. */
export type WebhookStatus = 'ok' | 'failing';

/** `backup_targets.kind` (§6.5 "Backups"): the restic backends. */
export const BACKUP_TARGET_KINDS = [
  'local',
  'ftp',
  'ftps',
  'sftp',
  's3',
  'webdav'
] as const;
export type BackupTargetKind = (typeof BACKUP_TARGET_KINDS)[number];

/** `backup_runs.status` (§6.5 "Backups"). */
export type BackupRunStatus = 'running' | 'ok' | 'failed';

/** `audit_log.channel` (§5.7): how an operation call reached the runner. */
export type AuditChannel = 'rest' | 'mcp' | 'ui' | 'undo' | 'job';

/** `calls.direction`. */
export const CALL_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/** `calls.status`. */
export const CALL_STATUSES = [
  'answered',
  'missed',
  'busy',
  'failed',
  'voicemail',
  'blocked',
  'interrupted'
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/** `call_qos.role` (§7 level `qos`). */
export type QosRole = 'caller' | 'callee';

/** `presence_log.status`. */
export type PresenceStatus = 'available' | 'busy' | 'offline' | 'dnd';

/** `maintenance_gate.work`: the certificate swap or the automatic update. */
export type MaintenanceWork = 'certSync' | 'autoUpdate';
