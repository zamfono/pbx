import { register } from '../registry.js';
import { get } from './get.js';
import { update } from './update.js';

register(get);
register(update);
