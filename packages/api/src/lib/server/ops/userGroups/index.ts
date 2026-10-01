import { register } from '../registry.js';
import { createUserGroup } from './create.js';
import { deleteUserGroup } from './delete.js';
import { getUserGroup } from './get.js';
import { listUserGroups } from './list.js';
import { updateUserGroup } from './update.js';

register(listUserGroups);
register(getUserGroup);
register(createUserGroup);
register(updateUserGroup);
register(deleteUserGroup);
