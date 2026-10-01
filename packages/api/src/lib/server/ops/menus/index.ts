import { register } from '../registry.js';
import { createMenu } from './create.js';
import { deleteMenu } from './delete.js';
import { getMenu } from './get.js';
import { getMenuTargets } from './getTargets.js';
import { listMenus } from './list.js';
import { setMenuTargets } from './setTargets.js';
import { updateMenu } from './update.js';

register(listMenus);
register(getMenu);
register(createMenu);
register(updateMenu);
register(deleteMenu);
register(getMenuTargets);
register(setMenuTargets);
