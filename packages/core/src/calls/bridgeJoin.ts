/**
 * A one-shot registry, keyed by `Call.id`, handing a ring race the existing bridge its win joins
 * (`legs.ts`'s `ringUser`/`winLeg` `existingBridgeId`) across `userStep.ts`'s `runUserStep` and
 * `ringGroup.ts`'s `ringGroup`, which take no such argument: `parking.ts`'s `ringParkerBack`
 * writes it for the parking ring-back (§10.2 "Call parking": "rings the parker back as an
 * internal call to the parker's extension ... whose answer lands in the parked bridge") and
 * `addParty.ts`'s `addParty` for `*5` to a user or ring-group extension (§10.2 "Three-way
 * calls"); `ringUser` reads it once when the ring starts and `ringGroupDial.ts`'s `winBatch` when
 * a batch wins, and the writer discards a never-read entry once resolution settles.
 */
import type { Pipeline } from './pipeline.js';

const joinBridgeByPipeline = new WeakMap<Pipeline, Map<string, string>>();

/** Marks `callId` so its next `winLeg` joins `bridgeId` instead of creating one of its own. */
export function joinExistingBridgeOnAnswer(
  pipeline: Pipeline,
  callId: string,
  bridgeId: string
): void {
  let map = joinBridgeByPipeline.get(pipeline);
  if (map === undefined) {
    map = new Map();
    joinBridgeByPipeline.set(pipeline, map);
  }
  map.set(callId, bridgeId);
}

/** Reads and clears `callId`'s bridge-to-join, if any, so a stale entry never outlives its one use. */
export function takeJoinBridge(
  pipeline: Pipeline,
  callId: string
): string | null {
  const map = joinBridgeByPipeline.get(pipeline);
  const bridgeId = map?.get(callId) ?? null;
  if (bridgeId !== null) {
    map?.delete(callId);
  }
  return bridgeId;
}
