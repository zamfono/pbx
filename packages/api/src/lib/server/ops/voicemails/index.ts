import { register } from '../registry.js';
import { audio } from './audio.js';
import { deleteVoicemail } from './delete.js';
import { list } from './list.js';
import { markRead } from './markRead.js';

register(list);
register(audio);
register(markRead);
register(deleteVoicemail);
