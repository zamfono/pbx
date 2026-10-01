import { register } from '../registry.js';
import { list } from './list.js';
import { replace } from './replace.js';

register(list);
register(replace);
