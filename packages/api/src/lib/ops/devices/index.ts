import { register } from '../registry.js';
import { create } from './create.js';
import { deleteDevice } from './delete.js';
import { getBlf } from './getBlf.js';
import { list } from './list.js';
import { revealCredentials } from './revealCredentials.js';
import { rotate } from './rotate.js';
import { setBlf } from './setBlf.js';
import { update } from './update.js';

register(list);
register(create);
register(update);
register(deleteDevice);
register(revealCredentials);
register(rotate);
register(getBlf);
register(setBlf);
