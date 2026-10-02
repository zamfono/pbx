/** Snapshot lookups `outbound.ts` needs to resolve a dialled string and its routes: route caller
 * lists, own DIDs, extensions, and the caller's own device (§9.2, §9.3, §9.4). */
import type { Channel } from '../ari/types.js';
import type { Snapshot } from '../internal/snapshot.js';
import type {
  DialAction,
  ExtensionRow,
  ResolveDialedContext
} from '../routing/outbound.js';
import type { Route } from '../routing/trunk.js';

/**
 * `calls.to` for a resolved dialled string (§10.1 "Outbound" step 4): the E.164 number for an
 * external or emergency call and for an own DID, since the steps from normalization on, route
 * patterns and history see only that form; the dialled digits otherwise (an internal extension, a
 * feature code).
 */
export function toFor(action: DialAction, dialed: string): string {
  return action.kind === 'external' ||
    action.kind === 'emergency' ||
    action.kind === 'ownDid'
    ? action.number
    : dialed;
}

/** `outbound_routes` and their caller/number lists (§9.4 "Outbound routing") as `Route[]`. */
export function buildRoutes(snapshot: Snapshot): Route[] {
  return snapshot.outboundRoutes
    .filter(row => row.deletedAt === null)
    .map(row => ({
      id: row.id,
      priority: row.priority,
      trunkId: row.trunkId,
      calleridDidId: row.calleridDidId,
      users: snapshot.outboundRouteUsers
        .filter(user => user.routeId === row.id)
        .map(user => user.userId),
      userGroups: snapshot.outboundRouteUserGroups
        .filter(group => group.routeId === row.id)
        .map(group => group.userGroupId),
      numbers: snapshot.outboundRouteNumbers
        .filter(number => number.routeId === row.id)
        .map(number => ({
          number: number.number,
          isPrefix: number.isPrefix === 1
        }))
    }));
}

/**
 * The groups `userId` matches for route caller lists (§9.4 "Outbound routing"): direct
 * memberships plus every ancestor group they nest under, so a route naming the parent group
 * matches a member of one of its nested subgroups too. A soft-deleted group is skipped (§5.9): the
 * snapshot holds live user groups only, while their link rows outlive the delete.
 */
export function callerGroupIds(userId: string, snapshot: Snapshot): string[] {
  const liveGroupIds = new Set(snapshot.userGroups.map(group => group.id));
  const parentsOf = new Map<string, string[]>();
  for (const row of snapshot.userGroupGroups) {
    if (!liveGroupIds.has(row.parentGroupId)) {
      continue;
    }
    const parents = parentsOf.get(row.childGroupId) ?? [];
    parents.push(row.parentGroupId);
    parentsOf.set(row.childGroupId, parents);
  }
  const queue = snapshot.userGroupUsers
    .filter(row => row.userId === userId && liveGroupIds.has(row.groupId))
    .map(row => row.groupId);
  const result = new Set<string>();
  // `queue.push` below extends the array the `for...of` iterator is still walking, so later
  // ancestors are visited without a second pass.
  for (const groupId of queue) {
    if (result.has(groupId)) {
      continue;
    }
    result.add(groupId);
    queue.push(...(parentsOf.get(groupId) ?? []));
  }
  return [...result];
}

export function didTargetsByNumber(
  snapshot: Snapshot
): Map<string, { id: string; targetId: string }> {
  return new Map(
    snapshot.dids
      .filter(row => row.deletedAt === null)
      .map(row => [row.number, { id: row.id, targetId: row.targetId }])
  );
}

export function buildExtensionsMap(
  snapshot: Snapshot
): Map<string, ExtensionRow> {
  return new Map(
    snapshot.extensions.map(row => [
      row.ext,
      {
        userId: row.userId,
        ringGroupId: row.ringGroupId,
        isParkingSlot: row.isParkingSlot === 1
      }
    ])
  );
}

/** The user whose device is `channel` (§9.3 "Naming": `e<ext>-d<slug>`), or `null` unmatched. */
export function identifyCallerUserId(
  channel: Channel,
  snapshot: Snapshot
): string | null {
  const resource = channel.name.replace(/^PJSIP\//u, '');
  const device = snapshot.devices.find(
    row =>
      row.deletedAt === null &&
      (resource === row.sipUsername ||
        resource.startsWith(`${row.sipUsername}-`))
  );
  return device?.userId ?? null;
}

/** What `resolveDialed` resolves a dialled string against (§10.1 "Outbound"): the tenant's feature
 * codes, emergency numbers, country and extension length, extensions and own DIDs. */
export function resolveDialedContext(snapshot: Snapshot): ResolveDialedContext {
  return {
    featureCodes: snapshot.settings.featureCodes,
    emergencyNumbers: snapshot.settings.emergencyNumbers,
    country: snapshot.settings.country,
    extLength: snapshot.settings.extLength,
    extensions: buildExtensionsMap(snapshot),
    dids: didTargetsByNumber(snapshot)
  };
}
