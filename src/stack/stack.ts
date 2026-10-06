import { randomUUID } from "node:crypto"
import type { ClosedFrame, PopOutcome, TaskDisposition, TaskFrame } from "../agent/types.ts"
import type { PopAction, PushAction } from "./schemas.ts"

let frameCounter = 0

export function createFrame(action: PushAction, now = Date.now()): TaskFrame {
  frameCounter += 1
  return {
    id: `f${frameCounter}-${randomUUID().slice(0, 8)}`,
    why: action.why,
    scope: action.scope,
    knownContext: action.knownContext ?? "",
    definitionOfDone: action.definitionOfDone,
    createdAt: now,
  }
}

/**
 * The explicit TODO stack. Only the top frame is executable.
 * Pop never implies success — it records a disposition.
 */
export class TaskStack {
  private frames: TaskFrame[] = []

  get depth(): number {
    return this.frames.length
  }

  get top(): TaskFrame | undefined {
    return this.frames[this.frames.length - 1]
  }

  get isEmpty(): boolean {
    return this.frames.length === 0
  }

  list(): readonly TaskFrame[] {
    return this.frames
  }

  /** Push a new frame; it becomes the top of stack. */
  push(action: PushAction, now = Date.now()): TaskFrame {
    const frame = createFrame(action, now)
    this.frames.push(frame)
    return frame
  }

  /** Close the top frame, combining intent + disposition into a ClosedFrame. */
  pop(action: PopAction, now = Date.now()): ClosedFrame {
    const frame = this.frames.pop()
    if (!frame) {
      throw new Error("Cannot pop: task stack is empty")
    }
    const disposition: TaskDisposition = {
      outcome: action.outcome as PopOutcome,
      whatWasDone: action.whatWasDone,
      whyClosed: action.whyClosed,
      evidence: action.evidence ?? "",
      effectsOnParent: action.effectsOnParent ?? "",
      closedAt: now,
    }
    return { intent: frame, disposition }
  }

  clear(): void {
    this.frames = []
  }

  restore(frames: TaskFrame[]): void {
    this.frames = [...frames]
  }
}
