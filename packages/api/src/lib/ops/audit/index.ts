import { register } from '../registry.js';
import { list } from './list.js';
import { undo } from './undo.js';

register(list);
register(undo);
