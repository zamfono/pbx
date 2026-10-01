import { register } from '../registry.js';
import { del } from './delete.js';
import { get } from './get.js';
import { list } from './list.js';
import { put } from './put.js';
import { test } from './test.js';

register(list);
register(get);
register(put);
register(del);
register(test);
