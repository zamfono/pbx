import { register } from '../registry.js';
import { lift } from './lift.js';
import { list } from './list.js';

register(list);
register(lift);
