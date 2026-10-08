/**
 * The demo tenant at the start of every demo: Brandt & Partner Steuerberatung, München. Built
 * fresh on each reset, with times relative to now. Voicemails and recordings get a generated audio
 * clip, and their caller is set to the person speaking in it.
 */
import manifest from '#lib/assets/audio/manifest.json';

import type { Call, Db, Recording, Voicemail } from '../types';
import { seedCalls } from './calls';
import { RG, U } from './ids';
import {
  seedBlf,
  seedDevices,
  seedPasskeys,
  seedPresence,
  seedTokens,
  seedUserForwarding,
  seedUserGroups,
  seedUsers
} from './people';
import {
  seedAudio,
  seedBlockedNumbers,
  seedContacts,
  seedDidBlocks,
  seedDids,
  seedMenus,
  seedOooRules,
  seedOpeningHours,
  seedOutboundRoutes,
  seedRingGroupForwarding,
  seedRingGroups,
  seedTrunks
} from './routing';
import {
  seedAudit,
  seedBackupRuns,
  seedBackupTargets,
  seedMailTemplates,
  seedRingotel,
  seedSettings,
  seedSipAllowlist,
  seedSipBans,
  seedSystem,
  seedWebhooks
} from './system';
import { plus } from './time';

type ClipInfo = {
  kind: 'voicemail' | 'recording';
  channels: number;
  durationS: number;
};
const clips = manifest as Record<string, ClipInfo>;

/** Who speaks in each clip: the caller a voicemail or recorded call is from. */
const VOICEMAIL_CLIPS: {
  clip: string;
  caller: string;
  mailboxUserId?: string;
  mailboxRingGroupId?: string;
}[] = [
  { clip: 'vm-felix-schuster', caller: '+49893344556', mailboxUserId: U.felix },
  { clip: 'vm-lea-maier', caller: '+49816155520', mailboxUserId: U.lea },
  { clip: 'vm-mira-kaya', caller: '+491715550177', mailboxUserId: U.mira },
  {
    clip: 'vm-empfang-huber',
    caller: '+49897788990',
    mailboxRingGroupId: RG.empfang
  }
];
const FALLBACK_VOICEMAIL = { clip: 'vm-short-lindner', caller: '+49897766554' };

const RECORDING_CLIPS: Record<string, { clip: string; counterpart: string }> = {
  [U.felix]: { clip: 'rec-felix-schuster', counterpart: '+49893344556' },
  [U.laura]: { clip: 'rec-laura-maier', counterpart: '+49816155520' },
  [U.daniel]: { clip: 'rec-daniel-bauer', counterpart: '+49816155530' },
  [U.lea]: { clip: 'rec-lea-kaya', counterpart: '+491715550177' }
};

const sip = (number: string): string => `sip:${number}@tel.brandt-partner.de`;

function setCaller(call: Call | undefined, caller: string): void {
  if (call === undefined || call.direction !== 'inbound') {
    return;
  }
  call.fromUri = sip(caller);
  const entry = call.log.find(line => line.event === 'entry');
  if (entry !== undefined) {
    entry.caller = caller;
  }
}

function assignVoicemailClips(
  voicemails: Voicemail[],
  calls: Map<string, Call>
): void {
  const used = new Set<string>();
  for (const spec of VOICEMAIL_CLIPS) {
    const target = voicemails.find(
      vm =>
        vm.clip === null &&
        (spec.mailboxUserId === undefined ||
          vm.mailboxUserId === spec.mailboxUserId) &&
        (spec.mailboxRingGroupId === undefined ||
          vm.mailboxRingGroupId === spec.mailboxRingGroupId)
    );
    if (target !== undefined) {
      target.clip = spec.clip;
      target.caller = spec.caller;
      used.add(target.id);
      setCaller(calls.get(target.callId ?? ''), spec.caller);
    }
  }
  for (const vm of voicemails) {
    if (vm.clip === null) {
      vm.clip = FALLBACK_VOICEMAIL.clip;
      vm.caller = FALLBACK_VOICEMAIL.caller;
      setCaller(calls.get(vm.callId ?? ''), FALLBACK_VOICEMAIL.caller);
    }
    vm.durationS = clips[vm.clip]?.durationS ?? vm.durationS;
  }
}

function assignRecordingClips(
  recordings: Recording[],
  calls: Map<string, Call>
): Recording[] {
  const kept: Recording[] = [];
  for (const recording of recordings) {
    const spec = RECORDING_CLIPS[recording.userId ?? ''];
    const call = calls.get(recording.callId);
    if (spec === undefined || call === undefined) {
      continue;
    }
    recording.clip = spec.clip;
    recording.durationS = clips[spec.clip]?.durationS ?? recording.durationS;
    if (call.direction === 'inbound') {
      setCaller(call, spec.counterpart);
    } else {
      call.toUri = sip(spec.counterpart);
    }
    if (call.answeredAt !== null) {
      call.endedAt = plus(call.answeredAt, recording.durationS);
      recording.createdAt = call.endedAt;
      const ended = call.log.find(line => line.event === 'ended');
      if (ended !== undefined) {
        ended.at = call.endedAt;
      }
    }
    kept.push(recording);
  }
  return kept;
}

export function seed(): Db {
  const users = seedUsers();
  const devices = seedDevices();
  const history = seedCalls();
  const callsById = new Map(history.calls.map(call => [call.id, call]));
  assignVoicemailClips(history.voicemails, callsById);
  const recordings = assignRecordingClips(history.recordings, callsById);

  return {
    settings: seedSettings(),
    users,
    devices,
    blf: seedBlf(devices),
    personalAccessTokens: seedTokens(),
    passkeys: seedPasskeys(),
    userForwarding: seedUserForwarding(),
    userGroups: seedUserGroups(),
    ringGroups: seedRingGroups(),
    ringGroupForwarding: seedRingGroupForwarding(),
    menus: seedMenus(),
    dids: seedDids(),
    didBlocks: seedDidBlocks(),
    outboundRoutes: seedOutboundRoutes(),
    trunks: seedTrunks(),
    blockedNumbers: seedBlockedNumbers(),
    oooRules: seedOooRules(),
    openingHours: seedOpeningHours(),
    audio: seedAudio(),
    contacts: seedContacts(),
    parkingSlots: [
      '701',
      '702',
      '703',
      '704',
      '705',
      '706',
      '707',
      '708',
      '709'
    ],
    parked: [],
    calls: history.calls,
    liveCalls: history.liveCalls,
    voicemails: history.voicemails,
    recordings,
    presence: seedPresence(users),
    presenceLog: history.presenceLog,
    sipBans: seedSipBans(),
    sipAllowlist: seedSipAllowlist(),
    webhooks: seedWebhooks(),
    backupTargets: seedBackupTargets(),
    backupRuns: seedBackupRuns(),
    mailTemplates: seedMailTemplates(),
    audit: seedAudit(),
    system: seedSystem(),
    ringotel: seedRingotel(),
    events: []
  };
}
