import { register } from '../registry.js';
import { get } from './get.js';
import { list } from './list.js';
import { set } from './set.js';

register(get);
register(set);
register(list);
