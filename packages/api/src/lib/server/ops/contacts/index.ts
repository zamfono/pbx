import { register } from '../registry.js';
import { createContact } from './create.js';
import { deleteContact } from './delete.js';
import { getContact } from './get.js';
import { listContacts } from './list.js';
import { updateContact } from './update.js';

register(listContacts);
register(getContact);
register(createContact);
register(updateContact);
register(deleteContact);
