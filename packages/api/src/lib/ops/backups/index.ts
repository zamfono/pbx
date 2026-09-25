import { register } from '../registry.js';
import { runsGet } from './runsGet.js';
import { runsList } from './runsList.js';
import { runsStart } from './runsStart.js';
import { targetsCreate } from './targetsCreate.js';
import { targetsDelete } from './targetsDelete.js';
import { targetsList } from './targetsList.js';
import { targetsUpdate } from './targetsUpdate.js';

register(targetsList);
register(targetsCreate);
register(targetsUpdate);
register(targetsDelete);
register(runsList);
register(runsGet);
register(runsStart);
