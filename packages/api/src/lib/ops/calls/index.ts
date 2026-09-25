import { register } from '../registry.js';
import { get } from './get.js';
import { hangup } from './hangup.js';
import { list } from './list.js';
import { originate } from './originate.js';
import { pickup } from './pickup.js';
import { transfer } from './transfer.js';

register(get);
register(list);
register(originate);
register(transfer);
register(pickup);
register(hangup);
