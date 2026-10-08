/** Registers every entity's field list (`entities/*.ts` call `defineFields`). */
import.meta.glob(['./entities/*.ts', '!./entities/*.test.ts'], { eager: true });

export {
  allEntityFields,
  entityFields,
  fieldAccess,
  fieldDef
} from './registry';
