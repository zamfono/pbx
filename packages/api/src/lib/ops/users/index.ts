import { register } from '../registry.js';
import { create } from './create.js';
import { deleteUser } from './delete.js';
import { erase } from './erase.js';
import { get } from './get.js';
import { list } from './list.js';
import { resetPassword } from './resetPassword.js';
import { setForwarding } from './setForwarding.js';
import { setPresence } from './setPresence.js';
import { update } from './update.js';

register(list);
register(get);
register(create);
register(update);
register(deleteUser);
register(resetPassword);
register(erase);
register(setForwarding);
register(setPresence);

export {
  setAccountLockLookup,
  type AccountLockLookup
} from './_accountLock.js';
