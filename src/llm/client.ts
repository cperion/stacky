import type { ModelAction, ToolName } from "../stack/schemas.ts"

export type ModelInput = {
  system: string
  prompt: string
  allowedTools: ToolName[]
  mode: string
}

/**
 * The runtime depends only on this narrow interface, never on a provider SDK.
 * It must return exactly one validated action.
 */
export interface LLMClient {
  step(input: ModelInput): Promise<ModelAction>
}

/** Raised when the model fails to produce exactly one valid tool call. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtocolError"
  }
}
