import { register } from '../registry.js';
import { checkUpdate } from './checkUpdate.js';
import { info } from './info.js';
import { update } from './update.js';

register(checkUpdate);
register(info);
register(update);
