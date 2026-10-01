import { register } from '../registry.js';
import { createRingGroup } from './create.js';
import { deleteRingGroup } from './delete.js';
import { getRingGroup } from './get.js';
import { listRingGroups } from './list.js';
import { setRingGroupForwarding } from './setForwarding.js';
import { updateRingGroup } from './update.js';

register(listRingGroups);
register(getRingGroup);
register(createRingGroup);
register(updateRingGroup);
register(deleteRingGroup);
register(setRingGroupForwarding);
