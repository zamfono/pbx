import { register } from '../registry.js';
import { del } from './delete.js';
import { get } from './get.js';
import { set } from './set.js';

register(get);
register(set);
register(del);
