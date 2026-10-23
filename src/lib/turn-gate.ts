/**
 * Small synchronous gate for the chat transport.
 *
 * React state updates are asynchronous, so a stale `busy` boolean cannot stop
 * two clicks/submissions that happen in the same tick. This gate is mutated
 * synchronously, and the generation token lets the store discard a response
 * that belongs to a conversation which has since been reset.
 */
export interface TurnGate {
  /** True while a turn owns the gate. */
  readonly busy: boolean;
  /** Current conversation generation. */
  readonly generation: number;
  /** Acquire the gate; returns a generation token or null when already busy. */
  tryAcquire(): number | null;
  /** Release a token. Stale tokens cannot free a newer conversation. */
  release(token: number): void;
  /** Invalidate the current conversation and reset the gate. */
  reset(): number;
  /** Is this token still part of the active conversation? */
  isCurrent(token: number): boolean;
}

export function createTurnGate(): TurnGate {
  let busy = false;
  let generation = 0;

  return {
    get busy() {
      return busy;
    },
    get generation() {
      return generation;
    },
    tryAcquire() {
      if (busy) return null;
      busy = true;
      return generation;
    },
    release(token) {
      if (token === generation) busy = false;
    },
    reset() {
      generation += 1;
      busy = false;
      return generation;
    },
    isCurrent(token) {
      return token === generation;
    },
  };
}
