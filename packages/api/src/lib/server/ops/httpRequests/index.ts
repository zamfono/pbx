import { register } from '../registry.js';
import { createHttpRequest } from './create.js';
import { deleteHttpRequest } from './delete.js';
import { getHttpRequest, listHttpRequests } from './read.js';
import { updateHttpRequest } from './update.js';

register(listHttpRequests);
register(getHttpRequest);
register(createHttpRequest);
register(updateHttpRequest);
register(deleteHttpRequest);
