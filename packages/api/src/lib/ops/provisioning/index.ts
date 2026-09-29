import { register } from '../registry.js';
import { ringotelAdopt } from './ringotelAdopt.js';
import { ringotelOptions } from './ringotelOptions.js';
import { ringotelSetup } from './ringotelSetup.js';

register(ringotelSetup);
register(ringotelAdopt);
register(ringotelOptions);
