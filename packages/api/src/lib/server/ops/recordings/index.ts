import { register } from '../registry.js';
import { audio } from './audio.js';
import { deleteRecording } from './delete.js';
import { list } from './list.js';

register(list);
register(audio);
register(deleteRecording);
