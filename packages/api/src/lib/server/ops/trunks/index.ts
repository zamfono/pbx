import { register } from '../registry.js';
import { create } from './create.js';
import { deleteTrunk } from './delete.js';
import { get } from './get.js';
import { list } from './list.js';
import { reregister } from './reregister.js';
import { setOrder } from './setOrder.js';
import { update } from './update.js';

register(create);
register(get);
register(list);
register(update);
register(deleteTrunk);
register(setOrder);
register(reregister);
