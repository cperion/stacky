import { appendFileSync } from "node:fs"
import type { EventBus } from "./events.ts"

/**
 * Append a machine-readable JSONL execution trace.
 * Essential for debugging agent behavior (implementation.md §35).
 */
export function attachTraceLogger(bus: EventBus, path: string): () => void {
  return bus.on((event) => {
    try {
      appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...event })}\n`, "utf8")
    } catch {
      // Logging must never break the runtime.
    }
  })
}
