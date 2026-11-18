/**
 * A `sip` target's custom headers on write (§10.3 "Forward targets", §9.4 "Header templates"): the
 * schema that refuses a bad name, a duplicate, a value that does not parse and headers too large
 * to send, and the warning for headers that could push an INVITE over UDP past a safe size. The
 * placeholders and the template syntax are `@zamfono/shared`'s, which `core` renders with; the
 * names a value reads are checked as the target is written (`templateNames.ts`).
 */
import { z } from 'zod';

import {
  lineTemplateProblem,
  SIP_HEADER_NAME_PATTERN,
  SIP_HEADER_PLACEHOLDERS,
  SIP_HEADERS_MAX_BYTES,
  sipHeadersSize,
  type SipHeaderTemplate
} from '@zamfono/shared';

import { noteWarning } from './afterCommit.js';
import type { Context } from './types.js';

/**
 * The room custom headers have in an INVITE over UDP (§10.3 "Forward targets"): an INVITE past
 * about 1300 bytes risks IP fragmentation, and the rest of a forwarded INVITE takes about 1150,
 * the harness's external forward measuring 1126 bytes without custom headers, rounded up.
 */
const UDP_INVITE_SAFE_BYTES = 1300;
const INVITE_BASELINE_BYTES = 1150;
export const UDP_HEADERS_ROOM_BYTES =
  UDP_INVITE_SAFE_BYTES - INVITE_BASELINE_BYTES;

/** Every placeholder a value may name, as `{{name}}`, for the value's description. */
const PLACEHOLDER_LIST = Object.keys(SIP_HEADER_PLACEHOLDERS)
  .map(name => `{{${name}}}`)
  .join(', ');

const headerSchema = z.object({
  name: z
    .string()
    .regex(SIP_HEADER_NAME_PATTERN, 'name must be X- and 1-64 of A-Z a-z 0-9 -')
    .describe('The header name: X- and 1 to 64 of A-Z a-z 0-9 -.'),
  value: z
    .string()
    .superRefine((value, ctx) => {
      const problem = lineTemplateProblem(value);
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', message: `value has ${problem}` });
      }
    })
    .describe(
      `Literal text with {{placeholder}} substitutions (see zamfono.help templates); the placeholders: ${PLACEHOLDER_LIST}.`
    )
});

/** A `sip` target's `headers`: no count limit, but names unique without case and at most
 * `SIP_HEADERS_MAX_BYTES` by their maximum rendered size. */
export const sipHeadersSchema = z
  .array(headerSchema)
  .superRefine((headers, ctx) => {
    const seen = new Set<string>();
    for (const [index, header] of headers.entries()) {
      const key = header.name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `header ${header.name} is given twice`
        });
      }
      seen.add(key);
    }
    const size = sipHeadersSize(headers);
    if (size > SIP_HEADERS_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `headers may render to ${size} bytes, more than ${SIP_HEADERS_MAX_BYTES}`
      });
    }
  });

/** The warning a `sip` target's `headers` get over `trunk` (§10.3 "Forward targets"): on a UDP
 * trunk, headers larger than the INVITE has room for; `null` otherwise. */
export function udpHeadersWarning(
  headers: readonly SipHeaderTemplate[],
  trunk: { name: string; transport: string }
): string | null {
  if (
    trunk.transport !== 'udp' ||
    sipHeadersSize(headers) <= UDP_HEADERS_ROOM_BYTES
  ) {
    return null;
  }
  return `sip target headers may push an INVITE over UDP trunk '${trunk.name}' past ${UDP_INVITE_SAFE_BYTES} bytes`;
}

/** Notes the warning a `sip` target's headers get over its trunk on `ctx`'s result (§10.3). */
export async function warnForSipHeaders(
  ctx: Context,
  trunkId: string,
  headers: SipHeaderTemplate[]
): Promise<void> {
  const trunk = await ctx.db
    .selectFrom('trunks')
    .select(['name', 'transport'])
    .where('id', '=', trunkId)
    .executeTakeFirstOrThrow();
  const warning = udpHeadersWarning(headers, trunk);
  if (warning !== null) {
    noteWarning(ctx, warning);
  }
}
