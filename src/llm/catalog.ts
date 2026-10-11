import type { ProviderName } from "./providers.ts"

export const PROVIDERS: ProviderName[] = ["deepseek", "anthropic", "openai", "chatgpt"]

/** Legacy config hints and startup defaults only — never a model-discovery source. */
export const MODEL_CATALOG: Record<ProviderName, string[]> = {
  deepseek: ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  openai: ["gpt-4o-mini", "gpt-4.1", "gpt-5", "o4-mini"],
  // Kept for existing configs; actual subscription availability comes from /codex/models.
  chatgpt: ["gpt-5-codex", "gpt-5", "gpt-5-mini", "codex-mini-latest"],
}

export function defaultModelFor(provider: ProviderName): string {
  return MODEL_CATALOG[provider][0] ?? "deepseek-flash"
}

export function providerForModel(model: string): ProviderName | undefined {
  for (const provider of PROVIDERS) {
    if (MODEL_CATALOG[provider].includes(model)) return provider
  }
  return undefined
}
