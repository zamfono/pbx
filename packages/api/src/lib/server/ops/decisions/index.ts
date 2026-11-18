import { register } from '../registry.js';
import { createDecision } from './create.js';
import { deleteDecision } from './delete.js';
import { dryRunDecision } from './dryRun.js';
import { getDecision } from './get.js';
import { listDecisions } from './list.js';
import { updateDecision } from './update.js';

register(listDecisions);
register(getDecision);
register(createDecision);
register(updateDecision);
register(deleteDecision);
register(dryRunDecision);
