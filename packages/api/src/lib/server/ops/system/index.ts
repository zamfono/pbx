import { register } from '../registry.js';
import { checkHost } from './checkHost.js';
import { checkUpdate } from './checkUpdate.js';
import { health } from './health.js';
import { info } from './info.js';
import { reboot } from './reboot.js';
import { update } from './update.js';

register(checkHost);
register(checkUpdate);
register(health);
register(info);
register(reboot);
register(update);
