import type { SharedV4ProviderOptions } from "@ai-sdk/provider"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"

export type ProviderName = "openai" | "anthropic" | "deepseek"

export type ProviderOptionsInput = {
  provider?: ProviderName
  model?: string
  apiKey?: string
  baseURL?: string
  /** Keep chain-of-thought thinking enabled (DeepSeek). Forces toolChoice "auto". */
  thinking?: boolean
}

export type ModelSpec = {
  model: LanguageModel
  provider: ProviderName
  modelId: string
  /** "required" gives the strictest tool-only contract; "auto" is needed for thinking models. */
  toolChoice: "required" | "auto"
  providerOptions?: SharedV4ProviderOptions
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
  deepseek: "deepseek-flash",
}

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
}

const PROVIDER_ORDER: ProviderName[] = ["deepseek", "anthropic", "openai"]

/** Pick a provider from explicit options, then env vars. DeepSeek is the default. */
export function detectProvider(opts: ProviderOptionsInput = {}): ProviderName {
  if (opts.provider) return opts.provider
  const fromEnv = process.env.STACKY_PROVIDER as ProviderName | undefined
  if (fromEnv && PROVIDER_ORDER.includes(fromEnv)) return fromEnv
  for (const provider of PROVIDER_ORDER) {
    if (process.env[ENV_KEYS[provider]]) return provider
  }
  return "deepseek"
}

export function createModel(opts: ProviderOptionsInput = {}): ModelSpec {
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

  // DeepSeek's thinking mode rejects tool_choice="required". Disable thinking by
  // default so the strict tool-only contract holds; --thinking opts back in.
  const thinking = opts.thinking ?? false
  const providerOptions: SharedV4ProviderOptions | undefined =
    provider === "deepseek"
      ? { deepseek: { thinking: { type: thinking ? "enabled" : "disabled" } } }
      : undefined

  return {
    model,
    provider,
    modelId,
    toolChoice: thinking ? "auto" : "required",
    ...(providerOptions ? { providerOptions } : {}),
  }
}
