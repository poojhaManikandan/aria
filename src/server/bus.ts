import type { TelemetryEvent } from '@/lib/types';

/**
 * In-process telemetry bus.
 *
 * The Next.js route handlers are bundled separately but run inside the same
 * Node process, so we stash the singleton on `globalThis` to guarantee that
 * `/api/chat` (publisher) and `/api/telemetry/stream` (subscriber) observe the
 * exact same event log.
 */

type Subscriber = (event: TelemetryEvent) => void;

class TelemetryBus {
  /** Rolling log of the most recent events (used for catch-up on subscribe). */
  private events: TelemetryEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private seq = 0;
  private maxHistory = 800;

  /** Allocate the next monotonic sequence number for a trace. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Publish an event to every live subscriber and append it to the history. */
  publish(event: TelemetryEvent): TelemetryEvent {
    this.events.push(event);
    if (this.events.length > this.maxHistory) {
      this.events.splice(0, this.events.length - this.maxHistory);
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A broken SSE pipe must never break the request pipeline.
      }
    }
    return event;
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Recent history, oldest → newest. */
  history(limit = 400): TelemetryEvent[] {
    return this.events.slice(-limit);
  }

  /** Wipe all state (used by the "Reset telemetry" control in the demo UI). */
  reset(): void {
    this.events = [];
    this.seq = 0;
  }
}

const GLOBAL_KEY = '__agentGuardTelemetryBus__';

type GlobalWithBus = typeof globalThis & { [GLOBAL_KEY]?: TelemetryBus };

/** Process-wide singleton bus. */
export const bus: TelemetryBus =
  (globalThis as GlobalWithBus)[GLOBAL_KEY] ?? new TelemetryBus();

(globalThis as GlobalWithBus)[GLOBAL_KEY] = bus;
