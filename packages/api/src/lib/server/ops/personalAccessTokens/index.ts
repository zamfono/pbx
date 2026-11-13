import { register } from '../registry.js';
import { create } from './create.js';
import { current } from './current.js';
import { list } from './list.js';
import { listAll } from './listAll.js';
import { revoke } from './revoke.js';

register(list);
register(listAll);
register(create);
register(revoke);
register(current);
