/**
 * Which calls still have a recording in progress (§10.6 "After-call requests"): a call's
 * after-call requests wait until every participation of it is recorded, finished and mixed, so
 * the recordings they name exist. `recording.ts` counts each participation in and out.
 */
export class CallsRecording {
  private readonly counts = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();

  /** A participation of call `callId` is in progress from here on. */
  begin(callId: string): void {
    this.counts.set(callId, (this.counts.get(callId) ?? 0) + 1);
  }

  /** One participation of call `callId` is over: stored, failed, moved to another call, or it
   * recorded nothing. Those waiting for the call go on once it was the last. */
  done(callId: string): void {
    const left = (this.counts.get(callId) ?? 1) - 1;
    if (left > 0) {
      this.counts.set(callId, left);
      return;
    }
    this.counts.delete(callId);
    for (const resolve of this.waiters.get(callId) ?? []) {
      resolve();
    }
    this.waiters.delete(callId);
  }

  /** Resolves once no participation of call `callId` is in progress. */
  settled(callId: string): Promise<void> {
    if (!this.counts.has(callId)) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.waiters.set(callId, [...(this.waiters.get(callId) ?? []), resolve]);
    });
  }
}
