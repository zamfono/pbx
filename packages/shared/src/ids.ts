import { v7 as uuidv7 } from 'uuid';

/** A new random, time-ordered entity id (UUIDv7). Every entity id in the schema uses this, never a hand-rolled generator (§11.1). */
export function newId(): string {
  return uuidv7();
}
