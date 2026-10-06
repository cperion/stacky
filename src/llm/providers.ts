import { createAnthropic } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"

export type ProviderName = "openai" | "anthropic" | "deepseek"

export type ProviderOptions = {
  provider?: ProviderName
  model?: string
  apiKey?: string
  baseURL?: string
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
  deepseek: "deepseek-chat",
}

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
}

/** Pick a provider from explicit options, then env vars. */
export function detectProvider(opts: ProviderOptions = {}): ProviderName {
  if (opts.provider) return opts.provider
  if (process.env.STACKY_PROVIDER) return process.env.STACKY_PROVIDER as ProviderName
  for (const provider of ["openai", "anthropic", "deepseek"] as ProviderName[]) {
    if (process.env[ENV_KEYS[provider]]) return provider
  }
  return "openai"
}

export function createModel(opts: ProviderOptions = {}): { model: LanguageModel; provider: ProviderName; modelId: string } {
  const provider = detectProvider(opts)
  const apiKey = opts.apiKey ?? process.env[ENV_KEYS[provider]]
  const modelId = opts.model ?? process.env.STACKY_MODEL ?? DEFAULT_MODELS[provider]

  let model: LanguageModel
  switch (provider) {
    case "anthropic":
      model = createAnthropic({ apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) })(modelId)
      break
    case "deepseek":
      model = createDeepSeek({ apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) })(modelId)
      break
    case "openai":
    default:
      model = createOpenAI({ apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) })(modelId)
      break
  }

  return { model, provider, modelId }
}
