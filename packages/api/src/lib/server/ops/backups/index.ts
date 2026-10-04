import { register } from '../registry.js';
import { runsGet } from './runs/get.js';
import { runsList } from './runs/list.js';
import { runsStart } from './runs/start.js';
import { targetsCreate } from './targets/create.js';
import { targetsDelete } from './targets/delete.js';
import { targetsList } from './targets/list.js';
import { targetsUpdate } from './targets/update.js';

register(targetsList);
register(targetsCreate);
register(targetsUpdate);
register(targetsDelete);
register(runsList);
register(runsGet);
register(runsStart);
