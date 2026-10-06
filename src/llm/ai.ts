import { generateText, stepCountIs, type LanguageModel } from "ai"
import { ACTION_SCHEMAS, type ModelAction, type ToolName } from "../stack/schemas.ts"
import { ProtocolError, type LLMClient, type ModelInput } from "./client.ts"
import { buildTools } from "./tools.ts"

export type AiSdkClientOptions = {
  temperature?: number
  maxOutputTokens?: number
}

/**
 * Vercel AI SDK implementation of the narrow LLM interface.
 *
 * Tools deliberately have no `execute`: the runtime owns execution. We stop
 * after exactly one step so each model turn maps to exactly one action.
 */
export class AiSdkClient implements LLMClient {
  constructor(
    private model: LanguageModel,
    private opts: AiSdkClientOptions = {},
  ) {}

  async step(input: ModelInput): Promise<ModelAction> {
    const result = await generateText({
      model: this.model,
      system: input.system,
      prompt: input.prompt,
      tools: buildTools(input.allowedTools),
      toolChoice: "required",
      stopWhen: stepCountIs(1),
      ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      ...(this.opts.maxOutputTokens !== undefined ? { maxOutputTokens: this.opts.maxOutputTokens } : {}),
    })

    const call = result.toolCalls[0]
    if (!call) {
      throw new ProtocolError("You must respond with exactly one tool call.")
    }

    const name = call.toolName as ToolName
    const schema = ACTION_SCHEMAS[name]
    if (!schema) {
      throw new ProtocolError(`Unknown tool "${name}". Allowed tools: ${input.allowedTools.join(", ")}.`)
    }

    const parsed = schema.safeParse(call.input)
    if (!parsed.success) {
      throw new ProtocolError(`Invalid input for ${name}: ${parsed.error.message}`)
    }

    return { tool: name, input: parsed.data } as ModelAction
  }
}
