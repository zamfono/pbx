/**
 * Outbound routes (`ops/outboundRoutes/`, admin, §9.4 "Outbound routing"): which trunk carries a
 * call, and which number it presents. The list is replaced as a whole and evaluated in order; a
 * call takes the first route whose callers and numbers both match, and falls through to the next
 * matching route when its trunk cannot carry it.
 */
import { invalid } from '../../errors';
import { newId } from '../../ids';
import type { OutboundRoute, RouteNumber } from '../../types';
import { defineOp } from '../core';
import { isNumericNumber } from './dids';

/** A route as `outboundRoutes.list` returns it: its position as `priority` (1 = first). */
export type RouteWire = OutboundRoute & { priority: number };

export type RouteInput = {
  /** An existing route's id, to keep it; left out: a new route. */
  id?: string;
  trunkId: string;
  callerIdDidId?: string | null;
  users: string[];
  userGroups: string[];
  numbers: { number: string; isPrefix?: boolean }[];
};

const hasDuplicates = (values: string[]): boolean =>
  new Set(values).size !== values.length;

defineOp<Record<string, never>, { items: RouteWire[] }>({
  name: 'outboundRoutes.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: ctx.db.outboundRoutes.map((route, index) => ({
      ...route,
      priority: index + 1
    }))
  })
});

defineOp<{ routes: RouteInput[] }, { items: RouteWire[] }>({
  name: 'outboundRoutes.replace',
  minRole: 'admin',
  run: (ctx, input) => {
    const db = ctx.db;
    const routes = Array.isArray(input.routes) ? input.routes : [];
    for (const route of routes) {
      if (hasDuplicates(route.users)) {
        throw invalid(
          'routes',
          'outboundRoutes.duplicateUser',
          'duplicate user in route'
        );
      }
      if (hasDuplicates(route.userGroups)) {
        throw invalid(
          'routes',
          'outboundRoutes.duplicateGroup',
          'duplicate user group in route'
        );
      }
      const bad = route.numbers.find(entry => !isNumericNumber(entry.number));
      if (bad !== undefined) {
        throw invalid(
          'routes',
          'outboundRoutes.numberE164',
          'number must be E.164',
          { number: bad.number }
        );
      }
      if (hasDuplicates(route.numbers.map(entry => entry.number))) {
        throw invalid(
          'routes',
          'outboundRoutes.duplicateNumber',
          'duplicate number in route'
        );
      }
    }
    // `assertTrunksLive`
    const deadTrunk = routes.find(
      route =>
        !db.trunks.some(
          trunk => trunk.id === route.trunkId && trunk.deletedAt === null
        )
    );
    if (deadTrunk !== undefined) {
      throw invalid(
        'routes',
        'outboundRoutes.trunkUnknown',
        `unknown or deleted trunk: ${deadTrunk.trunkId}`
      );
    }
    // `assertCallerIdsNumeric`
    for (const route of routes) {
      if (route.callerIdDidId === undefined || route.callerIdDidId === null) {
        continue;
      }
      const did = db.dids.find(
        row => row.id === route.callerIdDidId && row.deletedAt === null
      );
      if (did === undefined) {
        throw invalid(
          'routes',
          'outboundRoutes.didUnknown',
          `unknown or deleted DID: ${route.callerIdDidId}`
        );
      }
      if (!isNumericNumber(did.number)) {
        throw invalid(
          'routes',
          'outboundRoutes.didNotNumeric',
          `callerIdDidId must be a numeric DID: ${did.id}`,
          {
            number: did.number
          }
        );
      }
    }
    // `assertCallersExist`: a soft-deleted caller is accepted and matches nobody.
    const missingCaller =
      routes
        .flatMap(route => route.users)
        .find(id => !db.users.some(user => user.id === id)) ??
      routes
        .flatMap(route => route.userGroups)
        .find(id => !db.userGroups.some(group => group.id === id));
    if (missingCaller !== undefined) {
      throw invalid(
        'routes',
        'outboundRoutes.callerUnknown',
        `unknown user or user group: ${missingCaller}`
      );
    }
    // `assertRouteIdsLive`
    const ids = routes
      .map(route => route.id)
      .filter((id): id is string => id !== undefined);
    if (hasDuplicates(ids)) {
      throw invalid(
        'routes',
        'outboundRoutes.duplicateRoute',
        'duplicate route id'
      );
    }
    const unknownRoute = ids.find(
      id => !db.outboundRoutes.some(route => route.id === id)
    );
    if (unknownRoute !== undefined) {
      throw invalid(
        'routes',
        'outboundRoutes.routeUnknown',
        `unknown route id: ${unknownRoute}`
      );
    }

    const before = db.outboundRoutes.map(route => ({ ...route }));
    const after: OutboundRoute[] = routes.map(route => ({
      id: route.id ?? newId(),
      trunkId: route.trunkId,
      callerIdDidId: route.callerIdDidId ?? null,
      users: [...route.users],
      userGroups: [...route.userGroups],
      numbers: route.numbers.map((entry): RouteNumber => ({
        number: entry.number,
        isPrefix: entry.isPrefix === true
      }))
    }));
    ctx.setRoot('outboundRoutes', after);
    ctx.audit({
      entityKind: 'outboundRoute',
      entityId: null,
      changes: [{ field: 'routes', from: before, to: after }]
    });
    return {
      items: after.map((route, index) => ({ ...route, priority: index + 1 }))
    };
  }
});
