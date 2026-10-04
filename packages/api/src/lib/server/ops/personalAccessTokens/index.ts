import { register } from '../registry.js';
import { create } from './create.js';
import { list } from './list.js';
import { revoke } from './revoke.js';

register(list);
register(create);
register(revoke);
