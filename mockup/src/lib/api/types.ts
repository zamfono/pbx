/**
 * The tenant as the Zamfono API puts it on the wire (spec §10.3, §11.2): camelCase fields, JSON
 * columns without their suffix, secrets only as `<name>Set`. Every screen, Mucki and the simulator
 * read and write these shapes, so the mockup shows exactly what the API returns.
 */

export const ROLES = ['owner', 'admin', 'user'] as const;
export type Role = (typeof ROLES)[number];

export const LANGUAGES = ['de', 'en', 'es', 'fr', 'it', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

export const CODECS = ['opus', 'g722', 'amrwb', 'amr', 'alaw', 'ulaw'] as const;
export type Codec = (typeof CODECS)[number];

export const CALL_LOG_LEVELS = ['none', 'events', 'qos', 'sip'] as const;
export type CallLogLevel = (typeof CALL_LOG_LEVELS)[number];
export const LOG_LEVEL_OVERRIDES = ['events', 'qos', 'sip'] as const;
export type LogLevelOverride = (typeof LOG_LEVEL_OVERRIDES)[number];

export const PRESENCE_STATUSES = [
  'available',
  'busy',
  'offline',
  'dnd'
] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const AUDIO_KINDS = [
  'greeting',
  'moh',
  'vmGreeting',
  'announcement'
] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

export const MAIL_KINDS = [
  'voicemail',
  'missedCall',
  'setup',
  'reset',
  'updateFailed',
  'breakingUpdate',
  'mfaChanged'
] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export const EVENT_TYPES = [
  'presence',
  'call.state',
  'voicemail.new',
  'ooo',
  'hours',
  'trunk.status',
  'sipBan.added',
  'history.appended',
  'backup.started',
  'backup.finished',
  'backup.failed'
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const AUDIT_CHANNELS = ['rest', 'mcp', 'ui', 'undo', 'job'] as const;
export type AuditChannel = (typeof AUDIT_CHANNELS)[number];

export const FEATURE_CODE_KEYS = [
  'pickup',
  'dndOn',
  'dndOff',
  'mailbox',
  'ownVoicemail',
  'deposit',
  'addParty',
  'clirOn',
  'clirOff',
  'park'
] as const;
export type FeatureCodeKey = (typeof FEATURE_CODE_KEYS)[number];
export type FeatureCodes = Record<FeatureCodeKey, string>;

/* ------------------------------------------------------------------ */
/* Forward targets (§9.4): one value object, discriminated by `kind`. */
/* ------------------------------------------------------------------ */

export type SipHeader = { name: string; value: string };

export type ForwardTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'ringGroup'; ringGroupId: string }
  | { kind: 'external'; external: string; record: boolean }
  | {
      kind: 'sip';
      trunkId: string;
      user: string;
      headers: SipHeader[];
      record: boolean;
    }
  | { kind: 'mailboxUser'; userId: string }
  | { kind: 'mailboxRingGroup'; ringGroupId: string }
  | { kind: 'announcement'; audioId: string }
  | { kind: 'menu'; menuId: string };
export type ForwardTargetKind = ForwardTarget['kind'];
export const FORWARD_TARGET_KINDS: ForwardTargetKind[] = [
  'user',
  'ringGroup',
  'external',
  'sip',
  'mailboxUser',
  'mailboxRingGroup',
  'announcement',
  'menu'
];

/** The template variables a `sip` target's header values may use (§9.4). */
export const SIP_HEADER_VARIABLES = [
  'callerNumber',
  'callerName',
  'did',
  'calledExtension',
  'calledName',
  'forwardedByExtension',
  'forwardedByName',
  'forwardReason',
  'hopCount',
  'callId',
  'direction',
  'language',
  'startedAt'
] as const;

/* ------------------------------------------------------------------ */
/* Settings (§11.4)                                                    */
/* ------------------------------------------------------------------ */

export type Settings = {
  companyName: string;
  mainDidId: string;
  country: string;
  timezone: string | null;
  language: Language;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls';
  smtpUser: string | null;
  smtpPasswordSet: boolean;
  mailFrom: string | null;
  smtpCheckIntervalS: number | null;
  extLength: number;
  emergencyNumbers: string[];
  featureCodes: FeatureCodes;
  fallbackTarget: ForwardTarget | null;
  codecs: Codec[];
  clir: boolean;
  rejectAnonymous: boolean;
  holdMohAudioId: string | null;
  voicemailMaxS: number;
  parkingTimeoutS: number;
  callLogLevel: CallLogLevel;
  recordingRetentionDays: number | null;
  softDeleteRetentionDays: number | null;
  auditRetentionDays: number | null;
  sipBanFailures: number;
  sipBanWindowS: number;
  sipBanSuccessExemptS: number;
  sipBanLookbackS: number;
  sipBanSteps: (number | null)[];
  backupCron: string;
  tlsReloadHour: number | null;
  autoUpdate: boolean;
  mfaRequiredForAll: boolean;
  ssoProvider: 'microsoft' | 'google' | 'oidc' | null;
  ssoLabel: string | null;
  ssoIssuer: string | null;
  ssoClientId: string | null;
  ssoTenantId: string | null;
  ssoAllowedDomain: string | null;
  ssoClientSecretSet: boolean;
  ringotelMaxRegs: number;
  ringotelApiTokenSet: boolean;
  ringotelOrgId: string | null;
  ringotelBranchId: string | null;
};

/* ------------------------------------------------------------------ */
/* Users, devices, tokens                                              */
/* ------------------------------------------------------------------ */

export type FindMeLeg = { number: string; delayS: number };

export type User = {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  extension: string | null;
  ringTimeoutS: number;
  clir: boolean | null;
  rejectAnonymous: boolean | null;
  notifyMissedCalls: boolean;
  findMe: FindMeLeg[];
  recordCalls: boolean;
  mailboxEnabled: boolean;
  mailboxAudioId: string | null;
  mailboxMaxMessages: number | null;
  callerIdDidId: string | null;
  logLevel: LogLevelOverride | null;
  logLevelExpiresAt: string | null;
  dnd: boolean;
  lockedUntil: string | null;
  mfa: { totp: boolean; passkeys: number; recoveryCodesLeft: number };
  /** Whether a local password is set (an SSO-only or invited user has none). */
  passwordSet: boolean;
  ssoBound: boolean;
  createdAt: string;
  deletedAt: string | null;
};

/** Self-service fields a `user` may change on their own record (`users/_updateAccess.ts`). */
export const SELF_SERVICE_USER_FIELDS = [
  'clir',
  'rejectAnonymous',
  'ringTimeoutS',
  'notifyMissedCalls',
  'findMe'
] as const;

export const USER_FORWARD_CONDITIONS = [
  'unconditional',
  'busy',
  'noAnswer',
  'dnd',
  'offline'
] as const;
export type UserForwardCondition = (typeof USER_FORWARD_CONDITIONS)[number];
export type UserForwardRule = {
  condition: UserForwardCondition;
  target: ForwardTarget;
};

export type Device = {
  id: string;
  userId: string;
  label: string;
  kind: 'manual' | 'ringotel';
  transport: 'tls' | 'plain';
  allowedIps: string[];
  sipUsername: string;
  lastRegisteredAt: string | null;
  /** The mock keeps the secret to show once on reveal; the wire never carries it unasked. */
  password: string;
  createdAt: string;
  deletedAt: string | null;
};

export type BlfKeys = { deviceId: string; keys: string[] };

export type PersonalAccessToken = {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

/** One passkey of the security page (not an API resource; `/auth/security`). */
export type Passkey = {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/* ------------------------------------------------------------------ */
/* Groups, menus, numbers, routing                                     */
/* ------------------------------------------------------------------ */

export type Member = { kind: 'user' | 'userGroup'; id: string };

export type UserGroup = {
  id: string;
  name: string;
  members: Member[];
  createdAt: string;
  deletedAt: string | null;
};

export type RingGroup = {
  id: string;
  name: string;
  ext: string;
  strategy: 'simultaneous' | 'sequential' | 'random';
  members: Member[];
  ringTimeoutS: number;
  ringTotalS: number | null;
  skipBusy: boolean;
  allowReject: boolean;
  greetingAudioId: string | null;
  mohAudioId: string | null;
  recordCalls: boolean;
  mailboxEnabled: boolean;
  mailboxAudioId: string | null;
  mailboxMaxMessages: number | null;
  logLevel: LogLevelOverride | null;
  logLevelExpiresAt: string | null;
  createdAt: string;
  deletedAt: string | null;
};

export const RING_GROUP_FORWARD_CONDITIONS = [
  'unanswered',
  'unavailable'
] as const;
export type RingGroupForwardCondition =
  (typeof RING_GROUP_FORWARD_CONDITIONS)[number];
export type RingGroupForwardRule = {
  condition: RingGroupForwardCondition;
  target: ForwardTarget;
};

export type MenuTarget = { digits: string; target: ForwardTarget };

export type Menu = {
  id: string;
  name: string;
  audioId: string;
  timeoutS: number;
  maxAttempts: number;
  allowExtensionDialing: boolean;
  fallbackTarget: ForwardTarget;
  targets: MenuTarget[];
  createdAt: string;
  deletedAt: string | null;
};

export type Did = {
  id: string;
  number: string;
  label: string | null;
  target: ForwardTarget;
  createdAt: string;
  deletedAt: string | null;
};

export type DidBlock = {
  id: string;
  base: string;
  label: string | null;
  digits: number | null;
  fallbackTarget: ForwardTarget | null;
  createdAt: string;
  deletedAt: string | null;
};

export type RouteNumber = { number: string; isPrefix: boolean };

export type OutboundRoute = {
  id: string;
  trunkId: string;
  callerIdDidId: string | null;
  users: string[];
  userGroups: string[];
  numbers: RouteNumber[];
};

export type TrunkHost = {
  host: string;
  port: number | null;
  direction: 'both' | 'outbound' | 'inbound';
};

export type TrunkStatus =
  'registered' | 'unreachable' | 'unmonitored' | 'unknown';

export type Trunk = {
  id: string;
  name: string;
  emergency: boolean;
  authMode: 'registration' | 'ip';
  username: string | null;
  passwordSet: boolean;
  hosts: TrunkHost[];
  transport: 'udp' | 'tcp' | 'tls';
  inboundNumberFormat: 'e164' | 'national';
  callerIdFormat: 'e164' | 'national';
  callerIdHeader: 'from' | 'pai' | 'both';
  clir: boolean | null;
  maxChannels: number | null;
  diversion: 'off' | 'last' | 'all';
  forwardedCallerId: 'own' | 'original' | 'originalPreferred';
  inboundAuth: boolean;
  srtp: boolean;
  tlsVerify: boolean;
  qualify: boolean;
  outboundProxy: string | null;
  registerExpiryS: number | null;
  registerRetryS: number | null;
  codecs: Codec[] | null;
  logLevel: LogLevelOverride | null;
  logLevelExpiresAt: string | null;
  priority: number;
  status: TrunkStatus;
  statusChangedAt: string | null;
  registeredAt: string | null;
  createdAt: string;
  deletedAt: string | null;
};

export type BlockedNumber = {
  id: string;
  number: string;
  isPrefix: boolean;
  label: string | null;
  createdAt: string;
  deletedAt: string | null;
};

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

/** The scope an out-of-office rule or an opening-hours schedule belongs to (`ops/scope.ts`). */
export type ScheduleScope =
  | { kind: 'tenant' }
  | { kind: 'user'; id: string }
  | { kind: 'ringGroup'; id: string }
  | { kind: 'menu'; id: string };

export type OooRule = {
  id: string;
  scope: ScheduleScope;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  target: ForwardTarget;
  createdAt: string;
  deletedAt: string | null;
};

/** `weekday` 1 (Monday) … 7; `closes` may be `"24:00"`. */
export type HoursInterval = { weekday: number; opens: string; closes: string };

export type OpeningHours = {
  id: string;
  scope: ScheduleScope;
  active: boolean;
  closedTarget: ForwardTarget;
  intervals: HoursInterval[];
  deletedAt: string | null;
};

/* ------------------------------------------------------------------ */
/* Media, contacts, parking                                            */
/* ------------------------------------------------------------------ */

export type AudioAsset = {
  id: string;
  kind: AudioKind;
  label: string;
  durationS: number;
  bundled: boolean;
  createdAt: string;
  deletedAt: string | null;
};

export type ContactPhone = { label: string; number: string };

export type Contact = {
  id: string;
  displayName: string;
  company: string | null;
  email: string | null;
  phones: ContactPhone[];
  createdAt: string;
  deletedAt: string | null;
};

export type ParkedCall = {
  slot: string;
  callId: string;
  from: string;
  parkedByUserId: string | null;
  parkedAt: string;
};

/* ------------------------------------------------------------------ */
/* Calls, voicemail, recordings, presence                              */
/* ------------------------------------------------------------------ */

export type CallDirection = 'inbound' | 'outbound' | 'internal';
export type CallStatus =
  | 'answered'
  | 'missed'
  | 'busy'
  | 'failed'
  | 'voicemail'
  | 'blocked'
  | 'interrupted';

/** One routing-trace line of `calls.log` (§7 level `events`), as JSON lines on the wire. */
export type CallLogLine = { at: string; event: string } & Record<
  string,
  unknown
>;

export type CallQos = {
  channelId: string;
  role: 'caller' | 'callee';
  jitterMs: number | null;
  lossPct: number | null;
  rttMs: number | null;
  rxPackets: number | null;
  txPackets: number | null;
};

export type Call = {
  id: string;
  parentCallId: string | null;
  direction: CallDirection;
  fromUri: string;
  toUri: string;
  didId: string | null;
  callerUserId: string | null;
  calleeUserId: string | null;
  ringGroupId: string | null;
  answeredByUserId: string | null;
  status: CallStatus;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  /** `calls.get` only: the routing trace (JSON lines on the wire, parsed here). */
  log: CallLogLine[];
  /** `calls.get` only: SIP messages of level `sip`. */
  sipTrace: string[];
  qos: CallQos[];
};

export type LiveLeg = {
  id: string;
  role: 'caller' | 'callee' | 'added';
  state: 'ringing' | 'up' | 'held';
  userId?: string;
  deviceId?: string;
  trunkId?: string;
  target?: string;
};

export type LiveCall = {
  callId: string;
  direction: CallDirection;
  from: string;
  to: string;
  state: 'ringing' | 'up';
  startedAt: string;
  ringGroupId: string | null;
  userIds: string[];
  legs: LiveLeg[];
};

export type MailboxRef =
  { kind: 'user'; userId: string } | { kind: 'ringGroup'; ringGroupId: string };

export type Voicemail = {
  id: string;
  mailboxUserId: string | null;
  mailboxRingGroupId: string | null;
  /** The caller's number as presented (CLIP), `anonymous` when withheld. */
  caller: string;
  filename: string;
  durationS: number;
  read: boolean;
  createdAt: string;
  /** Mock-internal: the call that left it, and the demo audio clip it plays. */
  callId: string | null;
  clip: string | null;
};

/** One recording per recorded user and call (§10.2 "Recording semantics"). */
export type Recording = {
  id: string;
  callId: string;
  userId: string | null;
  filename: string;
  durationS: number;
  createdAt: string;
  /** Mock-internal: the demo audio clip it plays (stereo: left the user, right what they heard). */
  clip: string | null;
};

export type PresenceLogEntry = {
  userId: string;
  status: PresenceStatus;
  since: string;
  peer: string | null;
  ringGroupId: string | null;
};

/* ------------------------------------------------------------------ */
/* Security, integrations, operations                                  */
/* ------------------------------------------------------------------ */

export type SipBan = {
  id: string;
  address: string;
  reason: string;
  failures: number;
  step: number;
  createdAt: string;
  expiresAt: string | null;
  liftedAt: string | null;
};

export type SipAllowlistEntry = {
  id: string;
  address: string;
  label: string | null;
  createdAt: string;
  deletedAt: string | null;
};

export type Webhook = {
  id: string;
  url: string;
  secretSet: boolean;
  eventTypes: EventType[] | null;
  active: boolean;
  lastStatus: 'ok' | 'failing' | null;
  lastDeliveryAt: string | null;
  failingSince: string | null;
  failedDeliveries: number;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  deletedAt: string | null;
};

export const BACKUP_TARGET_KINDS = [
  'local',
  'ftp',
  'ftps',
  'sftp',
  's3',
  'webdav'
] as const;
export type BackupTargetKind = (typeof BACKUP_TARGET_KINDS)[number];

export type BackupForget = {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
};

export type BackupTarget = {
  id: string;
  kind: BackupTargetKind;
  label: string;
  /** Free-form per kind (`{host, path}`, `{endpoint, bucket, path}`, …) plus the forget policy. */
  params: Record<string, string | BackupForget>;
  secretSet: boolean;
  enabled: boolean;
  createdAt: string;
  deletedAt: string | null;
};

export type BackupRun = {
  id: string;
  targetId: string;
  status: 'running' | 'ok' | 'failed';
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  bytesAdded: number | null;
  bytesTotal: number | null;
  snapshotId: string | null;
  error: string | null;
};

export type MailTemplate = {
  kind: MailKind;
  language: Language;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  /** Whether a tenant override exists; otherwise the shipped template applies. */
  overridden: boolean;
};

export type ChangeEntry = { field: string; from: unknown; to: unknown };

/** The tables an undo can write back to (mock-internal; the API reverts through its operations). */
export type RowTable =
  | 'users'
  | 'devices'
  | 'personalAccessTokens'
  | 'userGroups'
  | 'ringGroups'
  | 'menus'
  | 'dids'
  | 'didBlocks'
  | 'trunks'
  | 'blockedNumbers'
  | 'oooRules'
  | 'openingHours'
  | 'audio'
  | 'contacts'
  | 'sipAllowlist'
  | 'webhooks'
  | 'backupTargets';
export type KeyTable = 'userForwarding' | 'ringGroupForwarding' | 'blf';
export type RootTable =
  'settings' | 'parkingSlots' | 'outboundRoutes' | 'mailTemplates';

/** How the mock reverts one write of an audit entry. `before: null` on a row means it was created. */
export type RevertStep =
  | { kind: 'row'; table: RowTable; id: string; before: unknown }
  | { kind: 'key'; table: KeyTable; key: string; before: unknown }
  | { kind: 'root'; table: RootTable; before: unknown };

export type AuditEntry = {
  id: string;
  actorUserId: string;
  actorUserName: string;
  channel: AuditChannel;
  clientId: string | null;
  clientName: string | null;
  operation: string;
  entityKind: string;
  entityId: string | null;
  changes: ChangeEntry[];
  undoable: boolean;
  revertsId: string | null;
  undoneAt: string | null;
  createdAt: string;
  /** Mock-internal: the writes an undo reverses. */
  revert?: RevertStep[];
  /** Mock-internal: a pure action (re-registration, manual backup run), which never blocks an undo. */
  pure?: boolean;
};

export type SystemInfo = {
  api: {
    version: string;
    revision: string;
    display: string;
    startedAt: string;
  };
  core: {
    version: string;
    revision: string;
    display: string;
    startedAt: string;
    asteriskStartedAt: string | null;
  } | null;
  update: {
    current: string | null;
    latest: { version: string; url: string; publishedAt: string } | null;
    updatable: boolean;
    breaking: boolean;
    last: {
      state: 'idle' | 'running' | 'succeeded' | 'failed';
      from?: string;
      to?: string;
      startedAt?: string;
      finishedAt?: string;
      trigger?: 'manual' | 'automatic' | 'host';
      by?: string;
    };
  };
  autoUpdate: {
    enabled: boolean;
    failed: null | { error: string; attempts: number };
  };
  ringotel: { profilePending: boolean; rosterPending: boolean };
  mail: {
    ok: boolean;
    at: string;
    error: null | { class: string; message: string };
  } | null;
  skippedConfigRows: { type: string; id: string; field: string }[];
  stack: { domain: string; ipv4: string };
  /** The mock's maintenance state while `system.update` runs. */
  maintenance: boolean;
};

export type RingotelProvisioning = {
  orgId: string | null;
  branchId: string | null;
  domain: string | null;
  region: string | null;
  packageId: number | null;
};

/* ------------------------------------------------------------------ */
/* Events (§10.6)                                                      */
/* ------------------------------------------------------------------ */

export type ScopeKey =
  'tenant' | `user:${string}` | `ringGroup:${string}` | `menu:${string}`;

type EventFields = {
  presence: {
    userId: string;
    status: PresenceStatus;
    peer: string | null;
    ringGroupId: string | null;
  };
  'call.state': {
    callId: string;
    state: 'ringing' | 'up' | 'ended';
    peer: string | null;
    ringGroupId: string | null;
    userId: string | null;
    legs: LiveLeg[];
  };
  'voicemail.new': { voicemailId: string; mailbox: MailboxRef };
  ooo: {
    scope: ScopeKey;
    active: boolean;
    startsAt: string | null;
    expiresAt: string | null;
  };
  hours: { scope: ScopeKey; open: boolean };
  'trunk.status': { trunkId: string; status: TrunkStatus };
  'sipBan.added': { banId: string; address: string; expiresAt: string | null };
  'history.appended': { callId: string };
  'backup.started': { targetId: string; runId: string };
  'backup.finished': {
    targetId: string;
    runId: string;
    snapshotId: string;
    bytesAdded: number | null;
    bytesTotal: number | null;
    durationS: number;
  };
  'backup.failed': { targetId: string; runId: string; error: string };
};

export type ZEvent = {
  [T in EventType]: { type: T } & EventFields[T];
}[EventType];

export type Envelope = ZEvent & {
  id: string;
  at: string;
  /** Mock-internal routing: users the event concerns (stripped from what a page displays). */
  audience?: string[];
};

/* ------------------------------------------------------------------ */
/* The whole tenant                                                    */
/* ------------------------------------------------------------------ */

export type Db = {
  settings: Settings;
  users: User[];
  devices: Device[];
  blf: BlfKeys[];
  personalAccessTokens: PersonalAccessToken[];
  passkeys: Passkey[];
  userForwarding: Record<string, UserForwardRule[]>;
  userGroups: UserGroup[];
  ringGroups: RingGroup[];
  ringGroupForwarding: Record<string, RingGroupForwardRule[]>;
  menus: Menu[];
  dids: Did[];
  didBlocks: DidBlock[];
  outboundRoutes: OutboundRoute[];
  trunks: Trunk[];
  blockedNumbers: BlockedNumber[];
  oooRules: OooRule[];
  openingHours: OpeningHours[];
  audio: AudioAsset[];
  contacts: Contact[];
  parkingSlots: string[];
  parked: ParkedCall[];
  calls: Call[];
  liveCalls: LiveCall[];
  voicemails: Voicemail[];
  recordings: Recording[];
  presence: Record<string, PresenceLogEntry>;
  presenceLog: PresenceLogEntry[];
  sipBans: SipBan[];
  sipAllowlist: SipAllowlistEntry[];
  webhooks: Webhook[];
  backupTargets: BackupTarget[];
  backupRuns: BackupRun[];
  mailTemplates: MailTemplate[];
  audit: AuditEntry[];
  system: SystemInfo;
  ringotel: RingotelProvisioning;
  events: Envelope[];
};
