/**
 * One zod schema per JSON text column (§11.2), and the codec every reader in `core` and `api`
 * decodes that column with, so a stored value reaches code checked and typed.
 */
import { z } from 'zod';

import { EVENT_TYPES } from './events.js';
import { featureCodesSchema } from './featureCodes.js';
import { isE164 } from './numbers.js';
import type { SipHeaderTemplate } from './sipHeaders.js';

/** The codecs the image ships (§9.1): every name a `codecs_json` list may hold. */
export const CODECS = ['opus', 'g722', 'amrwb', 'amr', 'alaw', 'ulaw'] as const;
export type Codec = (typeof CODECS)[number];

/** `settings.codecs_json` and `trunks.codecs_json`: an ordered, non-empty codec offer (§9.4). */
export const codecsSchema = z.array(z.enum(CODECS)).min(1);

/** `settings.emergency_numbers_json`: the digit strings dialled out as emergency calls (§10.1). */
export const emergencyNumbersSchema = z
  .array(z.string().regex(/^[0-9]+$/u))
  .min(1);

/** `users.find_me_json`: each leg dials out (§10.1), so its number is E.164. */
export const findMeSchema = z
  .array(
    z.object({
      number: z
        .string()
        .refine(isE164, 'number must be E.164')
        .describe('The external number this leg rings, E.164.'),
      delayS: z
        .number()
        .int()
        .min(0)
        .describe(
          'Seconds after ringing begins before this leg starts; 0 rings with the devices.'
        )
    })
  )
  .describe(
    "External numbers rung alongside the user's devices on direct calls, never through a ring group; the answerer presses 1 to accept; self-service."
  );
export type FindMeLeg = z.infer<typeof findMeSchema>[number];

/** `devices.allowed_ips_json`: the IPs and CIDR ranges a `plain` device's ACL permits (§9.3). */
export const allowedIpsSchema = z.array(z.string());

/** `forward_targets.sip_headers_json`: a `sip` target's header templates (§9.4). */
export const sipHeaderTemplatesSchema: z.ZodType<SipHeaderTemplate[]> = z.array(
  z.object({ name: z.string(), value: z.string() })
);

/** `webhooks.event_types_json`: the event types a hook is delivered (§10.6). */
export const eventTypesSchema = z.array(z.enum(EVENT_TYPES));

/** `backup_targets.params_json`: the repository location and forget policy, free-form per kind
 * (§6.5 "Backups"). */
export const backupParamsSchema = z.record(z.string(), z.unknown());

/** One field-level change, as `audit_log.changes_json` stores it (§5.7). */
export const changeEntrySchema = z.object({
  field: z.string(),
  from: z.unknown(),
  to: z.unknown()
});
export type ChangeEntry = z.infer<typeof changeEntrySchema>;

/** `text` parsed as JSON, or an `invalid_format` issue on `ctx`. */
function parseJson(
  text: string,
  ctx: Pick<z.core.ParsePayload, 'issues'>
): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    ctx.issues.push({
      code: 'invalid_format',
      format: 'json',
      input: text,
      message: (error as Error).message
    });
    return z.NEVER;
  }
}

/** A JSON text column holding a `schema` value: `decode` parses and checks it, `encode` writes it. */
function jsonColumn<T extends z.ZodType>(
  schema: T
): z.ZodCodec<z.ZodString, T> {
  return z.codec(z.string(), schema, {
    decode: (text, ctx) => parseJson(text, ctx) as z.input<T>,
    encode: value => JSON.stringify(value)
  });
}

export const codecsColumn = jsonColumn(codecsSchema);
export const emergencyNumbersColumn = jsonColumn(emergencyNumbersSchema);
export const featureCodesColumn = jsonColumn(featureCodesSchema);
export const allowedIpsColumn = jsonColumn(allowedIpsSchema);
export const sipHeadersColumn = jsonColumn(sipHeaderTemplatesSchema);
export const eventTypesColumn = jsonColumn(eventTypesSchema);
export const backupParamsColumn = jsonColumn(backupParamsSchema);
export const changesColumn = jsonColumn(z.array(changeEntrySchema));

/** `users.find_me_json`, where NULL means no find-me legs (§11.2): decoded, NULL is the empty list. */
export const findMeColumn = z.codec(z.string().nullable(), findMeSchema, {
  decode: (text, ctx) =>
    text === null ? [] : (parseJson(text, ctx) as z.input<typeof findMeSchema>),
  encode: legs => JSON.stringify(legs)
});
