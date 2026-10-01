import { register } from '../registry.js';
import { create } from './create.js';
import { del } from './delete.js';
import { list } from './list.js';
import { update } from './update.js';

register(list);
register(create);
register(update);
register(del);
