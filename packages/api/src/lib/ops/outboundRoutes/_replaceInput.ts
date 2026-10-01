import { z } from 'zod';

import { isE164 } from '@zamfono/shared';

/** One entry of a route's number list (§9.4 "Outbound routing", §11.2 `outbound_route_numbers`). */
const numberInputSchema = z
  .object({
    number: z
      .string()
      .refine(isE164, 'number must be E.164')
      .describe(
        'An E.164 number or, with isPrefix, the start of one, such as +49.'
      ),
    isPrefix: z
      .boolean()
      .optional()
      .describe(
        'Matches every dialled number that begins with number; false or left out: that number exactly.'
      )
  })
  .strict();

/**
 * One route (§9.4 "Outbound routing"): a call matches when both its caller and number lists pass,
 * an empty list passing everything.
 */
const routeInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe("An existing route's id, to keep it; left out: a new route."),
    trunkId: z.string().min(1).describe('The trunk that carries the call.'),
    calleridDidId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "A numeric DID this route presents as caller ID, ahead of the caller's own and the main number; null: no override."
      ),
    users: z
      .array(z.string().min(1))
      .refine(users => new Set(users).size === users.length, {
        message: 'duplicate user in route'
      })
      .describe(
        'User ids allowed to call over this route; with userGroups also empty, every caller, legs the system dials included.'
      ),
    userGroups: z
      .array(z.string().min(1))
      .refine(userGroups => new Set(userGroups).size === userGroups.length, {
        message: 'duplicate user group in route'
      })
      .describe(
        'User group ids, nested groups flattened, whose members may call over this route.'
      ),
    numbers: z
      .array(numberInputSchema)
      .refine(
        numbers =>
          new Set(numbers.map(number => number.number)).size === numbers.length,
        { message: 'duplicate number in route' }
      )
      .describe('The dialled numbers this route carries; empty: every number.')
  })
  .strict();

/** `PUT /outboundRoutes`'s body: the whole list, position giving priority (§9.4). */
export const replaceInputSchema = z
  .object({
    routes: z
      .array(routeInputSchema)
      .describe(
        'Every route in evaluation order; a live route left out is deleted. Keep a catch-all (no callers, no numbers) last as the default.'
      )
  })
  .strict();
