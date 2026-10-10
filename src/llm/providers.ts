import { createAnthropic } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import { createChatGptModel } from "./chatgpt.ts"
import { hasChatGptAuth } from "./oauth.ts"
import { defaultModelFor } from "./catalog.ts"

export type ProviderName = "openai" | "anthropic" | "deepseek" | "chatgpt"

export type CreateModelInput = {
  provider?: ProviderName
  model?: string
  apiKey?: string
  baseURL?: string
}

export type LanguageModelHandle = {
  model: LanguageModel
  provider: ProviderName
  modelId: string
  hasApiKey: boolean
}

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  chatgpt: "CHATGPT_OAUTH",
}

const PROVIDER_ORDER: ProviderName[] = ["deepseek", "anthropic", "openai", "chatgpt"]

export function apiKeyEnvName(provider: ProviderName): string {
  return ENV_KEYS[provider]
}

export function hasApiKey(provider: ProviderName): boolean {
  if (provider === "chatgpt") return hasChatGptAuth()
  return Boolean(process.env[ENV_KEYS[provider]])
}

/** Pick a provider from explicit options, then env vars. DeepSeek is the default. */
export function detectProvider(provider?: ProviderName): ProviderName {
  if (provider) return provider
  const fromEnv = process.env.STACKY_PROVIDER as ProviderName | undefined
  if (fromEnv && PROVIDER_ORDER.includes(fromEnv)) return fromEnv
  for (const candidate of PROVIDER_ORDER) {
    if (hasApiKey(candidate)) return candidate
  }
  return "deepseek"
}

export function createLanguageModel(input: CreateModelInput = {}): LanguageModelHandle {
  const provider = detectProvider(input.provider)
  const modelId = input.model ?? process.env.STACKY_MODEL ?? defaultModelFor(provider)
  const apiKey = input.apiKey ?? process.env[ENV_KEYS[provider]]
  const baseURL = input.baseURL ? { baseURL: input.baseURL } : {}

  let model: LanguageModel
  switch (provider) {
    case "anthropic":
      model = createAnthropic({ apiKey, ...baseURL })(modelId)
      break
    case "deepseek":
      model = createDeepSeek({ apiKey, ...baseURL })(modelId)
      break
    case "chatgpt":
      model = createChatGptModel(modelId)
      break
    case "openai":
    default:
      model = createOpenAI({ apiKey, ...baseURL })(modelId)
      break
  }

  const hasKey = provider === "chatgpt" ? hasChatGptAuth() : Boolean(apiKey)
  return { model, provider, modelId, hasApiKey: hasKey }
}
