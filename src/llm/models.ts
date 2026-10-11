import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { MODEL_CATALOG } from "./catalog.ts"
import { CHATGPT_BASE_URL, ensureFreshAuth } from "./oauth.ts"
import { apiKeyEnvName, type ProviderName } from "./providers.ts"

/**
 * The model list is whatever the provider says it is. We fetch it, rank known
 * ids first, cache it (memory + disk, TTL) and only fall back to the built-in
 * catalog when the provider can't be reached at all.
 */
const TTL_MS = 10 * 60 * 1000

export type ModelSource = "api" | "cache" | "catalog"
export type ModelList = { ids: string[]; source: ModelSource }

type Entry = { ids: string[]; at: number }
const memory = new Map<ProviderName, Entry>()

const ENDPOINTS: Record<ProviderName, string | undefined> = {
  openai: "https://api.openai.com/v1/models",
  deepseek: "https://api.deepseek.com/models",
  anthropic: "https://api.anthropic.com/v1/models",
  chatgpt: `${CHATGPT_BASE_URL}/models`,
}

function diskPath(): string {
  return process.env.STACKY_MODELS ?? join(homedir(), ".config", "stacky", "models.json")
}

function readDisk(): Partial<Record<ProviderName, Entry>> {
  try {
    return JSON.parse(readFileSync(diskPath(), "utf8")) as Partial<Record<ProviderName, Entry>>
  } catch {
    return {}
  }
}

function writeDisk(provider: ProviderName, entry: Entry): void {
  try {
    const all = readDisk()
    all[provider] = entry
    mkdirSync(dirname(diskPath()), { recursive: true })
    writeFileSync(diskPath(), `${JSON.stringify(all, null, 2)}\n`)
  } catch {
    // A cache that can't be written is not an error.
  }
}

/** Extract model ids from the many shapes providers use. */
export function parseModelIds(body: unknown): string[] {
  const ids: string[] = []
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) ids.push(value.trim())
  }
  const fromArray = (items: unknown[]): void => {
    for (const item of items) {
      if (typeof item === "string") add(item)
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>
        add(record.id ?? record.slug ?? record.model ?? record.name)
      }
    }
  }
  if (Array.isArray(body)) fromArray(body)
  else if (body && typeof body === "object") {
    const record = body as Record<string, unknown>
    for (const key of ["data", "models", "items", "available"]) {
      if (Array.isArray(record[key])) fromArray(record[key] as unknown[])
    }
  }
  return [...new Set(ids)]
}

/** Known ids first (nicer defaults), then everything else alphabetically. */
export function rankModels(provider: ProviderName, ids: string[]): string[] {
  const curated = MODEL_CATALOG[provider].filter((id) => ids.includes(id))
  const rest = ids.filter((id) => !curated.includes(id)).sort()
  return [...curated, ...rest]
}

async function headersFor(provider: ProviderName): Promise<Record<string, string> | undefined> {
  if (provider === "chatgpt") {
    try {
      const auth = await ensureFreshAuth()
      return {
        authorization: `Bearer ${auth.access_token}`,
        "OpenAI-Beta": "responses=experimental",
        originator: "stacky",
        ...(auth.account_id ? { "chatgpt-account-id": auth.account_id } : {}),
      }
    } catch {
      return undefined
    }
  }
  const key = process.env[apiKeyEnvName(provider)]
  if (!key) return undefined
  return provider === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key}` }
}

export async function listModels(provider: ProviderName, options: { force?: boolean } = {}): Promise<ModelList> {
  const now = Date.now()
  if (!options.force) {
    const cached = memory.get(provider)
    if (cached && now - cached.at < TTL_MS) return { ids: cached.ids, source: "api" }
  }

  const endpoint = ENDPOINTS[provider]
  const headers = await headersFor(provider)
  if (endpoint && headers) {
    try {
      const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(6_000) })
      if (response.ok) {
        const ids = parseModelIds(await response.json())
        if (ids.length > 0) {
          const entry: Entry = { ids: rankModels(provider, ids), at: now }
          memory.set(provider, entry)
          writeDisk(provider, entry)
          return { ids: entry.ids, source: "api" }
        }
      }
    } catch {
      // Offline / blocked: use the last known list.
    }
  }

  const disk = readDisk()[provider]
  if (disk && Array.isArray(disk.ids) && disk.ids.length > 0) return { ids: disk.ids, source: "cache" }
  return { ids: MODEL_CATALOG[provider], source: "catalog" }
}

/** Sync view for menus and tab completion: memory -> disk -> catalog. */
export function cachedModels(provider: ProviderName): string[] {
  const cached = memory.get(provider)
  if (cached) return cached.ids
  const disk = readDisk()[provider]
  if (disk && Array.isArray(disk.ids) && disk.ids.length > 0) return disk.ids
  return MODEL_CATALOG[provider]
}

export function clearModelCache(provider?: ProviderName): void {
  if (provider) memory.delete(provider)
  else memory.clear()
}
