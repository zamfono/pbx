import { z } from 'zod';

import { targetSpecSchema } from '../forwardTargetSchema.js';

/** A DID's wire shape (§10.3 "Extensions & DIDs"), as every `dids` operation returns it. */
export const didOut = z.object({
  id: z.string(),
  number: z.string(),
  label: z.string().nullable(),
  target: targetSpecSchema,
  createdAt: z.string()
});
export type DidOut = z.infer<typeof didOut>;
