import { register } from '../registry.js';
import { info } from './info.js';
import { update } from './update.js';

register(info);
register(update);
