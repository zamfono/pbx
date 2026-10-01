import { register } from '../registry.js';
import { addParty } from './addParty.js';
import { consult } from './consult.js';
import { decline } from './decline.js';
import { get } from './get.js';
import { hangup } from './hangup.js';
import { hold } from './hold.js';
import { list } from './list.js';
import { originate } from './originate.js';
import { park } from './park.js';
import { pickup } from './pickup.js';
import { resume } from './resume.js';
import { transfer } from './transfer.js';

register(get);
register(list);
register(originate);
register(transfer);
register(pickup);
register(hangup);
register(park);
// Call control beside hangup and transfer (§10.3 "Live calls").
register(consult);
register(addParty);
register(hold);
register(resume);
register(decline);
