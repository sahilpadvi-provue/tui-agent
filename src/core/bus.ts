import type { AgentEvent, EmitInput, EventType } from "./events.ts";

type Handler = (e: AgentEvent) => void;

/**
 * In-process typed pub/sub. The only path from the runtime to any client.
 *
 * This is deliberately not a transport. Promoting it to one later means
 * replacing this file, not changing its producers -- which is the whole
 * reason the UI is forbidden from calling the runtime directly.
 */
export class EventBus {
  #handlers = new Set<Handler>();
  #typed = new Map<EventType, Set<Handler>>();
  #seq = 0;

  /** Assigns the sequence number. Nothing else may set `seq`. */
  emit(e: EmitInput): AgentEvent {
    const full = {
      ...e,
      seq: this.#seq++,
      at: e.at ?? new Date().toISOString(),
    } as AgentEvent;

    for (const h of this.#typed.get(full.type) ?? []) h(full);
    for (const h of this.#handlers) h(full);
    return full;
  }

  on(handler: Handler): () => void;
  on(type: EventType, handler: Handler): () => void;
  on(a: EventType | Handler, b?: Handler): () => void {
    if (typeof a === "function") {
      this.#handlers.add(a);
      return () => this.#handlers.delete(a);
    }
    const set = this.#typed.get(a) ?? new Set<Handler>();
    set.add(b!);
    this.#typed.set(a, set);
    return () => set.delete(b!);
  }

  get seq(): number {
    return this.#seq;
  }

  /** Used only when rehydrating a resumed session. */
  resumeFrom(seq: number): void {
    this.#seq = seq;
  }
}
