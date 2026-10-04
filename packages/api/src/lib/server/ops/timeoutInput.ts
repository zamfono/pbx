import { z } from 'zod';

import { MAX_TIMEOUT_S } from '@zamfono/shared';

/** A timeout in whole seconds: at least one, at most a day (§11.1). */
export const timeoutSeconds = z.number().int().positive().max(MAX_TIMEOUT_S);
