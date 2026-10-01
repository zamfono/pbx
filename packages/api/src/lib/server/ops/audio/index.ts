import { register } from '../registry.js';
import { createAudioAsset } from './create.js';
import { deleteAudioAsset } from './delete.js';
import { listAudioAssets } from './list.js';
import { updateAudioAsset } from './update.js';

register(listAudioAssets);
register(createAudioAsset);
register(updateAudioAsset);
register(deleteAudioAsset);
