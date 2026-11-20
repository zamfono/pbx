/**
 * The prose of the OpenAPI document (§10.3) that no operation's schema carries: the API's own
 * description and one line per tag, an area of operations (`openapi.ts`), with the admin guide's
 * topic on it where there is one. The guide is linked on GitHub's main branch, since the document
 * is built before the image learns its release.
 */

export const REPOSITORY_URL = 'https://github.com/zamfono/pbx';
const GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/guide`;

export const API_CONTACT = {
  name: 'Zamfono on GitHub',
  url: `${REPOSITORY_URL}/issues`
};
export const API_DOCS = {
  description: 'The admin guide',
  url: `${REPOSITORY_URL}/tree/main/docs/guide`
};

/** The admin guide's `topic` as an OpenAPI `externalDocs`. */
function guide(topic: string): { description: string; url: string } {
  return {
    description: `Admin guide: ${topic}`,
    url: `${GUIDE_URL}/${topic}.md`
  };
}

export const API_DESCRIPTION =
  'The REST API of a Zamfono stack, a self-hosted phone system: users, devices, trunks, numbers, ring groups, menus, call routing and the calls themselves. ' +
  'Every request carries a bearer token, an OAuth 2.1 access token or a personal access token (zpat_…) for a server application, and acts with its user’s role. ' +
  'An error is an RFC 9457 problem (application/problem+json). A list answers a page, { items, nextPageToken, totalSize }, the next one asked for with pageToken. ' +
  'An operation that asks for confirmation answers 409 with its question until it is sent again with confirm: true. ' +
  'Every write is recorded in the audit log, and most can be undone there (POST /audit/{id}/undo). ' +
  'The same operations are MCP tools at /mcp, where zamfono.help serves the admin guide: start with its topic mental-model.';

/** One line per area, keyed by the first part of the operation names it holds. */
export const TAGS: Readonly<
  Record<
    string,
    { description: string; externalDocs?: ReturnType<typeof guide> }
  >
> = {
  audio: {
    description:
      'Audio assets: greetings, announcements and hold music, uploaded once and named by the targets, menus and ring groups that play them.'
  },
  audit: {
    description:
      'The audit log of every change, by whom and through which channel, and the undo of an entry.',
    externalDocs: guide('guardrails')
  },
  backups: {
    description:
      'Backup targets, restic repositories the scheduled runs back up to, and the runs themselves.',
    externalDocs: guide('restore')
  },
  blockedNumbers: {
    description:
      'The inbound blocklist: numbers and prefixes whose calls are refused.'
  },
  calls: {
    description:
      'Call history and the calls in progress: click-to-dial, transfer, pickup, park, hold, three-way calls and hanging up.',
    externalDocs: guide('call-control')
  },
  contacts: {
    description:
      'The tenant-wide phone book, whose numbers name inbound callers.',
    externalDocs: guide('directory')
  },
  decisions: {
    description:
      'Decisions, call-flow nodes that send a call to the first case whose conditions match, with a dry run to test them.',
    externalDocs: guide('decisions')
  },
  devices: {
    description:
      'A user’s SIP devices, softphones and desk phones: their credentials, provisioning and key lists.',
    externalDocs: guide('yealink-desk-phones')
  },
  didBlocks: {
    description:
      'Number blocks: a base and a digit count that group DIDs and route the numbers of the block no DID names.',
    externalDocs: guide('numbers')
  },
  dids: {
    description:
      'DIDs, the phone numbers the tenant owns, and the forward target each one’s calls go to.',
    externalDocs: guide('numbers')
  },
  hours: {
    description:
      'Opening hours of a user, ring group, menu or the tenant, and where calls go while closed.',
    externalDocs: guide('routing-order')
  },
  httpRequests: {
    description:
      'HTTP requests of call flows, sent while a call waits, whose JSON answer later targets and conditions read.',
    externalDocs: guide('http-requests')
  },
  mailTemplates: {
    description:
      'The mails the stack sends, as shipped or as the tenant overrides them, per kind and language.',
    externalDocs: guide('mail-templates')
  },
  menus: {
    description:
      'Auto-attendant menus: a greeting, the digits a caller presses and where each sends the call.'
  },
  ooo: {
    description:
      'Out-of-office rules of a user, ring group, menu or the tenant, which send its calls elsewhere ahead of opening hours.',
    externalDocs: guide('routing-order')
  },
  outboundRoutes: {
    description:
      'Outbound routes, the ordered list that picks a trunk and caller ID for a call leaving the stack.',
    externalDocs: guide('caller-id')
  },
  parking: {
    description:
      'Call parking: the slot extensions and the calls parked on them.',
    externalDocs: guide('parking')
  },
  personalAccessTokens: {
    description:
      'Personal access tokens, with which a server application acts as a user on this API and over MCP.'
  },
  presenceLog: { description: 'Users’ presence as it was at a past moment.' },
  provisioning: {
    description:
      'Setting up the Ringotel organization and connection the Ringotel softphone app registers through.'
  },
  recordings: {
    description: 'Call recordings and their audio.',
    externalDocs: guide('recording-consent')
  },
  ringGroups: {
    description:
      'Ring groups, which ring several users at once, in turn or at random, and where their unanswered calls go.'
  },
  search: {
    description:
      'The type-ahead across users, ring groups, decisions, menus and contacts.'
  },
  settings: {
    description:
      'Tenant-wide settings: main number, fallback, country, language, mail relay, feature codes, retention and more.'
  },
  sipAllowlist: {
    description: 'Source addresses and ranges the SIP ban never bans.'
  },
  sipBans: {
    description: 'Bans of sources of failed SIP attempts, and ending one early.'
  },
  stats: {
    description:
      'Call metrics over time: answer rate, time to answer, call length and volume.'
  },
  system: {
    description:
      'The stack itself: versions, health, updates and, with host control, the host’s reboot.'
  },
  trunks: {
    description:
      'SIP trunks to a phone provider, their order and their registration.',
    externalDocs: guide('caller-id')
  },
  userGroups: {
    description:
      'User groups, nestable sets of users for ring-group membership and outbound-route callers.',
    externalDocs: guide('user-groups')
  },
  users: {
    description:
      'Users: their profile, sign-in, call forwarding, presence and voicemail greeting.'
  },
  voicemails: {
    description:
      'Voicemails of a user’s mailbox and their ring groups’, with their audio.',
    externalDocs: guide('call-data')
  },
  webhooks: {
    description:
      'Webhooks, endpoints the stack POSTs its events to, with their delivery health.',
    externalDocs: guide('webhooks')
  }
};
