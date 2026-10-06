import type { SharedV4ProviderOptions } from "@ai-sdk/provider"
import { stepCountIs, streamText, type LanguageModel } from "ai"
import { ACTION_SCHEMAS, type ModelAction, type ToolName } from "../stack/schemas.ts"
import { ProtocolError, type LLMClient, type ModelInput, type StreamHandlers } from "./client.ts"
import { buildTools } from "./tools.ts"

export type ReasoningSetting = "none" | "provider-default" | "minimal" | "low" | "medium" | "high"

export type AiSdkClientOptions = {
  label?: string
  temperature?: number
  maxOutputTokens?: number
  /**
   * "required" enforces the tool-only contract at the API level.
   * Thinking/reasoning models reject it, so they use "auto": the runtime then
   * relies on the system prompt plus protocol-error retries to recover.
   */
  toolChoice?: "required" | "auto"
  /** Top-level, provider-agnostic reasoning control. "none" disables thinking. */
  reasoning?: ReasoningSetting
  providerOptions?: SharedV4ProviderOptions
}

/**
 * Vercel AI SDK implementation of the narrow LLM interface.
 *
 * Uses `streamText` so reasoning and text deltas reach the UI live. Tools have
 * no `execute`: the runtime owns execution. We stop after exactly one step so
 * each model turn maps to exactly one action.
 */
export class AiSdkClient implements LLMClient {
  readonly label: string

  constructor(
    private model: LanguageModel,
    private opts: AiSdkClientOptions = {},
  ) {
    this.label = opts.label ?? "model"
  }

  async step(input: ModelInput, handlers?: StreamHandlers): Promise<ModelAction> {
    const result = streamText({
      model: this.model,
      system: input.system,
      prompt: input.prompt,
      tools: buildTools(input.allowedTools),
      toolChoice: this.opts.toolChoice ?? "required",
      stopWhen: stepCountIs(1),
      ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      ...(this.opts.maxOutputTokens !== undefined ? { maxOutputTokens: this.opts.maxOutputTokens } : {}),
      ...(this.opts.reasoning !== undefined ? { reasoning: this.opts.reasoning } : {}),
      ...(this.opts.providerOptions ? { providerOptions: this.opts.providerOptions } : {}),
    })

    let toolName: string | undefined
    let toolInput: unknown
    let text = ""

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta":
          handlers?.onReasoningDelta?.(part.text)
          break
        case "text-delta":
          text += part.text
          handlers?.onTextDelta?.(part.text)
          break
        case "tool-input-start":
          toolName = part.toolName
          handlers?.onToolStart?.(part.toolName)
          break
        case "tool-call":
          toolName = part.toolName
          toolInput = part.input
          break
        case "error":
          throw toError(part.error)
        default:
          break
      }
    }

    if (!toolName) {
      const prose = text.trim()
      throw new ProtocolError(
        prose
          ? `You must respond with exactly one tool call, not text. You wrote: ${truncate(prose)}`
          : "You must respond with exactly one tool call.",
      )
    }

    const name = toolName as ToolName
    const schema = ACTION_SCHEMAS[name]
    if (!schema) {
      throw new ProtocolError(`Unknown tool "${name}". Allowed tools: ${input.allowedTools.join(", ")}.`)
    }

    const parsed = schema.safeParse(toolInput)
    if (!parsed.success) {
      throw new ProtocolError(`Invalid input for ${name}: ${parsed.error.message}`)
    }

    return { tool: name, input: parsed.data } as ModelAction
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === "string" ? value : JSON.stringify(value))
}

function truncate(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}
