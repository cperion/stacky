import { AiSdkClient, type ReasoningSetting } from "./ai.ts"
import type { LLMClient } from "./client.ts"
import { createLanguageModel, type ProviderName } from "./providers.ts"

export type LLMConfig = {
  provider: ProviderName
  model: string
  thinking: boolean
}

export type ModelInfo = {
  provider: ProviderName
  modelId: string
  thinking: boolean
  hasApiKey: boolean
  toolChoice: "required" | "auto"
  label: string
}

/**
 * Providers whose default is "no reasoning" should not receive an explicit
 * `reasoning: "none"`. DeepSeek V4 models think by default, so it must be
 * disabled explicitly.
 */
export function reasoningFor(provider: ProviderName, thinking: boolean): ReasoningSetting | undefined {
  if (provider === "deepseek") return thinking ? "provider-default" : "none"
  return thinking ? "provider-default" : undefined
}

export function buildLLM(config: LLMConfig): { llm: LLMClient; info: ModelInfo } {
  const handle = createLanguageModel({ provider: config.provider, model: config.model })
  const reasoning = reasoningFor(handle.provider, config.thinking)
  // Thinking models reject tool_choice="required", so relax to "auto" and rely
  // on the system prompt + protocol-error retries.
  const toolChoice: "required" | "auto" = config.thinking ? "auto" : "required"

  const label = `${handle.provider}/${handle.modelId}`
  const llm = new AiSdkClient(handle.model, {
    label,
    toolChoice,
    ...(reasoning ? { reasoning } : {}),
    ...(toolChoice === "required" ? { temperature: 0 } : {}),
  })

  return {
    llm,
    info: {
      provider: handle.provider,
      modelId: handle.modelId,
      thinking: config.thinking,
      hasApiKey: handle.hasApiKey,
      toolChoice,
      label,
    },
  }
}