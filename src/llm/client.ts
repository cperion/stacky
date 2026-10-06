import type { ModelAction, ToolName } from "../stack/schemas.ts"

export type ModelInput = {
  system: string
  prompt: string
  allowedTools: ToolName[]
  mode: string
}

/** Streaming callbacks. The runtime forwards these to the UI as they arrive. */
export type StreamHandlers = {
  onReasoningDelta?: (text: string) => void
  onTextDelta?: (text: string) => void
  onToolStart?: (toolName: string) => void
}

/**
 * The runtime depends only on this narrow interface, never on a provider SDK.
 * `step` must resolve to exactly one validated action.
 */
export interface LLMClient {
  /** Human-readable provider/model label shown in the UI. */
  readonly label: string
  step(input: ModelInput, handlers?: StreamHandlers, signal?: AbortSignal): Promise<ModelAction>
}

/** Raised when the model fails to produce exactly one valid tool call. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtocolError"
  }
}
