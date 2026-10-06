import type { ClosedFrame, ConversationEntry, TaskFrame, UserRequestRecord } from "./types.ts"

export type RuntimeEvent =
  | { type: "model.call.started"; mode: string }
  | { type: "model.call.finished"; tool: string }
  | { type: "model.call.aborted" }
  | { type: "tool.started"; tool: string }
  | { type: "tool.finished"; tool: string; ok: boolean }
  | { type: "frame.pushed"; frame: TaskFrame }
  | { type: "frame.popped"; frame: ClosedFrame }
  | { type: "file.promoted"; path: string; tokens: number }
  | { type: "file.evicted"; path: string }
  | { type: "user.request"; request: UserRequestRecord }
  | { type: "user.resolved"; request: UserRequestRecord }
  | { type: "conversation.added"; entry: ConversationEntry }
  | { type: "subagent.started"; depth: number; frame: TaskFrame }
  | { type: "subagent.finished"; depth: number; report: string }
  | { type: "protocol.error"; message: string }
  | { type: "state.changed" }
  | { type: "fatal"; message: string }

export type RuntimeListener = (event: RuntimeEvent) => void

/** Tiny synchronous event bus between the runtime and any observer (UI, logger). */
export class EventBus {
  private listeners = new Set<RuntimeListener>()

  on(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // Observers must never break the runtime.
      }
    }
  }
}
