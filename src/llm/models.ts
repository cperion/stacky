import { MODEL_CATALOG } from "./catalog.ts"
import { apiKeyEnvName, type ProviderName } from "./providers.ts"

/**
 * Ask the provider for its model list, falling back to the curated catalog when
 * there is no key, the endpoint is unreachable, or the reply is unexpected.
 * Results are cached per provider for the process lifetime.
 */
const cache = new Map<ProviderName, string[]>()

const ENDPOINTS: Record<ProviderName, string | undefined> = {
  openai: "https://api.openai.com/v1/models",
  deepseek: "https://api.deepseek.com/models",
  anthropic: "https://api.anthropic.com/v1/models",
  // The ChatGPT backend's listing endpoint is undocumented; use the catalog.
  chatgpt: undefined,
}

export async function listModels(provider: ProviderName): Promise<string[]> {
  const cached = cache.get(provider)
  if (cached) return cached

  const endpoint = ENDPOINTS[provider]
  const key = process.env[apiKeyEnvName(provider)]
  if (!endpoint || !key) return MODEL_CATALOG[provider]

  try {
    const response = await fetch(endpoint, {
      headers:
        provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) return MODEL_CATALOG[provider]
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    if (ids.length === 0) return MODEL_CATALOG[provider]
    // Curated first (nicer names), then everything else the provider offers.
    const curated = MODEL_CATALOG[provider].filter((model) => ids.includes(model))
    const rest = ids.filter((id) => !curated.includes(id)).sort()
    const models = [...curated, ...rest]
    cache.set(provider, models)
    return models
  } catch {
    return MODEL_CATALOG[provider]
  }
}

export function clearModelCache(): void {
  cache.clear()
}

/** Sync view of the last fetched list (or the curated catalog). */
export function cachedModels(provider: ProviderName): string[] {
  return cache.get(provider) ?? MODEL_CATALOG[provider]
}
