/**
 * The REST route table (§10.3): one `(method, path pattern) → operation` row per endpoint, and
 * how each row builds its operation's path-derived input fields. `rest.ts` matches requests
 * against it; `openapi.ts` documents it.
 */
// Side-effect import: fills the registry (§10.3) with the operations the rows below name.
import './ops/index.js';

import { registry, type ErasedOperation } from './ops/registry.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type ParamsFn = (match: RegExpMatchArray) => Record<string, unknown>;

/** One row of the REST route table (§10.3): a `(method, path pattern) → operation` mapping. */
export type RouteEntry = {
  method: HttpMethod;
  /** An OpenAPI 3.1 path template (`/users/{id}`); `{name}` segments become regex captures. */
  pattern: string;
  op: string;
  /** Builds the operation input's path-derived fields; defaults to the pattern's own capture names. */
  params?: ParamsFn;
  multipart?: true;
};

/** The pattern's own capture names, spread verbatim; every route's default unless it overrides `params`. */
export function defaultParams(match: RegExpMatchArray): Record<string, string> {
  return { ...match.groups };
}

function withUserId(match: RegExpMatchArray): Record<string, string> {
  return { userId: match.groups?.id ?? '' };
}

type RouteExtra = { params?: ParamsFn; multipart?: true };
type RouteTuple = readonly [HttpMethod, string, string, RouteExtra?];

function toRouteEntry([method, pattern, op, extra]: RouteTuple): RouteEntry {
  return { method, pattern, op, ...extra };
}

const WITH_USER_ID: RouteExtra = { params: withUserId };
const MULTIPART: RouteExtra = { multipart: true };

type CrudOp = 'list' | 'get' | 'create' | 'update' | 'delete';

/** The standard `list/get/create/update/delete` shape most areas of §10.3 follow, `ops` naming which ones this area has. */
function crud(area: string, base: string, ops: CrudOp[]): RouteTuple[] {
  const byOp: Record<CrudOp, RouteTuple> = {
    list: ['GET', base, `${area}.list`],
    get: ['GET', `${base}/{id}`, `${area}.get`],
    create: ['POST', base, `${area}.create`],
    update: ['PATCH', `${base}/{id}`, `${area}.update`],
    delete: ['DELETE', `${base}/{id}`, `${area}.delete`]
  };
  return ops.map(op => byOp[op]);
}

const ALL_CRUD: CrudOp[] = ['list', 'get', 'create', 'update', 'delete'];
const NO_GET: CrudOp[] = ['list', 'create', 'update', 'delete'];

/** The scopes §10.3's Out of Office and Opening hours rows attach OOO rules and hours to. */
type ScopeArea = 'user' | 'ringGroup' | 'menu' | 'tenant';
const SCOPE_BASE: Record<ScopeArea, string> = {
  user: '/users/{id}',
  ringGroup: '/ringGroups/{id}',
  menu: '/menus/{id}',
  tenant: '/tenant'
};
type ScopeEntry = [HttpMethod, string];

/**
 * One `{scope}/{suffix}` route per scope area for each `[method, op]`, the op call told which
 * scope it addresses. The operation takes the scope as one discriminated object (§10.3), so the
 * path's area and id are assembled into that shape here; `tenant`'s base carries no `{id}`.
 */
function scopeRoutes(suffix: string, entries: ScopeEntry[]): RouteTuple[] {
  return (Object.keys(SCOPE_BASE) as ScopeArea[]).flatMap(area =>
    entries.map(([method, op]): RouteTuple => [
      method,
      `${SCOPE_BASE[area]}/${suffix}`,
      op,
      {
        params: match => {
          const id = match.groups?.id;
          return {
            scope: id === undefined ? { kind: area } : { kind: area, id }
          };
        }
      }
    ])
  );
}

// §10.3's REST surface table, one row per endpoint.
const STATIC_ROUTES: RouteTuple[] = [
  ...crud('users', '/users', ALL_CRUD),
  ['POST', '/users/{id}/resetPassword', 'users.resetPassword'],
  ['POST', '/users/{id}/erase', 'users.erase'],
  ['GET', '/users/{id}/forwarding', 'users.getForwarding'],
  ['PUT', '/users/{id}/forwarding', 'users.setForwarding'],
  ['PUT', '/users/{id}/presence', 'users.setPresence'],
  [
    'PUT',
    '/users/{id}/voicemailGreeting',
    'users.setVoicemailGreeting',
    MULTIPART
  ],
  ['DELETE', '/users/{id}/voicemailGreeting', 'users.clearVoicemailGreeting'],
  ['GET', '/users/{id}/devices', 'devices.list', WITH_USER_ID],
  ['POST', '/users/{id}/devices', 'devices.create', WITH_USER_ID],
  ['PATCH', '/devices/{id}', 'devices.update'],
  ['DELETE', '/devices/{id}', 'devices.delete'],
  ['GET', '/devices/{id}/credentials', 'devices.revealCredentials'],
  ['POST', '/devices/{id}/rotate', 'devices.rotate'],
  ['GET', '/devices/{id}/blf', 'devices.getBlf'],
  ['PUT', '/devices/{id}/blf', 'devices.setBlf'],
  ['POST', '/provisioning/ringotel/setup', 'provisioning.ringotelSetup'],
  ['POST', '/provisioning/ringotel/adopt', 'provisioning.ringotelAdopt'],
  ['GET', '/provisioning/ringotel/options', 'provisioning.ringotelOptions'],
  ...crud('trunks', '/trunks', ALL_CRUD),
  ['PUT', '/trunks/order', 'trunks.setOrder'],
  ['GET', '/outboundRoutes', 'outboundRoutes.list'],
  ['PUT', '/outboundRoutes', 'outboundRoutes.replace'],
  ...crud('dids', '/dids', NO_GET),
  ...crud('didBlocks', '/didBlocks', NO_GET),
  ...crud('ringGroups', '/ringGroups', ALL_CRUD),
  ['PUT', '/ringGroups/{id}/forwarding', 'ringGroups.setForwarding'],
  ...crud('userGroups', '/userGroups', ALL_CRUD),
  ...crud('audio', '/audio', ['list', 'update', 'delete']),
  ['POST', '/audio', 'audio.create', MULTIPART],
  ['GET', '/voicemails', 'voicemails.list'],
  ['GET', '/voicemails/{id}/audio', 'voicemails.audio'],
  ['PATCH', '/voicemails/{id}', 'voicemails.markRead'],
  ['DELETE', '/voicemails/{id}', 'voicemails.delete'],
  ['GET', '/recordings', 'recordings.list'],
  ['GET', '/recordings/{id}/audio', 'recordings.audio'],
  ['DELETE', '/recordings/{id}', 'recordings.delete'],
  ['GET', '/calls', 'calls.list'],
  ['POST', '/calls', 'calls.originate'],
  ['GET', '/calls/{id}', 'calls.get'],
  ['POST', '/calls/{id}/transfer', 'calls.transfer'],
  ['POST', '/calls/{id}/pickup', 'calls.pickup'],
  ['POST', '/calls/{id}/hangup', 'calls.hangup'],
  ['POST', '/calls/{id}/park', 'calls.park'],
  ['POST', '/calls/{id}/consult', 'calls.consult'],
  ['POST', '/calls/{id}/parties', 'calls.addParty'],
  ['POST', '/calls/{id}/hold', 'calls.hold'],
  ['POST', '/calls/{id}/resume', 'calls.resume'],
  ['POST', '/calls/{id}/decline', 'calls.decline'],
  ['GET', '/presence/log', 'presenceLog.snapshot'],
  ['GET', '/stats', 'stats.query'],
  ...crud('contacts', '/contacts', ALL_CRUD),
  ...crud('blockedNumbers', '/blockedNumbers', ['list', 'create', 'delete']),
  ['GET', '/parking/slots', 'parking.get'],
  ['PUT', '/parking/slots', 'parking.set'],
  ['GET', '/parking/calls', 'parking.list'],
  ...crud('menus', '/menus', ALL_CRUD),
  ['GET', '/menus/{id}/targets', 'menus.getTargets'],
  ['PUT', '/menus/{id}/targets', 'menus.setTargets'],
  ...scopeRoutes('ooo', [
    ['GET', 'ooo.list'],
    ['POST', 'ooo.create']
  ]),
  ['PATCH', '/ooo/{id}', 'ooo.update'],
  ['DELETE', '/ooo/{id}', 'ooo.delete'],
  ...scopeRoutes('hours', [
    ['GET', 'hours.get'],
    ['PUT', 'hours.set'],
    ['DELETE', 'hours.delete']
  ]),
  ...crud('webhooks', '/webhooks', NO_GET),
  ['GET', '/mailTemplates', 'mailTemplates.list'],
  ['GET', '/mailTemplates/{kind}/{language}', 'mailTemplates.get'],
  ['PUT', '/mailTemplates/{kind}/{language}', 'mailTemplates.put'],
  ['DELETE', '/mailTemplates/{kind}/{language}', 'mailTemplates.delete'],
  ['POST', '/mailTemplates/{kind}/test', 'mailTemplates.test'],
  ...crud('backups.targets', '/backups/targets', NO_GET),
  ['GET', '/backups/runs', 'backups.runs.list'],
  ['POST', '/backups/runs', 'backups.runs.start'],
  ['GET', '/backups/runs/{id}', 'backups.runs.get'],
  ['GET', '/settings', 'settings.get'],
  ['GET', '/system/info', 'system.info'],
  ['POST', '/system/update', 'system.update'],
  ['PATCH', '/settings', 'settings.update'],
  ['GET', '/search', 'search.query'],
  ['GET', '/audit', 'audit.list'],
  ['POST', '/audit/{id}/undo', 'audit.undo']
];

export const routes: RouteEntry[] = STATIC_ROUTES.map(toRouteEntry);

/** The operation `route` runs; every row names a registered one, so a miss is a bug in the table. */
export function routeOperation(route: RouteEntry): ErasedOperation {
  const op = registry.get(route.op);
  if (!op) {
    throw new Error(
      `restRoutes: ${route.method} ${route.pattern} names no registered operation '${route.op}'`
    );
  }
  return op;
}
