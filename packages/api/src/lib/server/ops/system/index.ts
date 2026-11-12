import { register } from '../registry.js';
import { checkHost } from './checkHost.js';
import { checkUpdate } from './checkUpdate.js';
import { info } from './info.js';
import { reboot } from './reboot.js';
import { update } from './update.js';

register(checkHost);
register(checkUpdate);
register(info);
register(reboot);
register(update);
