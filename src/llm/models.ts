import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CHATGPT_BASE_URL, ensureFreshAuth, loadAuth, OAuthResponseError } from "./oauth.ts"
import { apiKeyEnvName, type ProviderName } from "./providers.ts"

// Codex discovery negotiates catalog compatibility, independently of stacky's version.
// Contract: openai/codex codex-rs/codex-api/src/endpoint/models.rs (ModelsClient).
export const CODEX_MODELS_CLIENT_VERSION = "0.162.1"
const TTL_MS = 10 * 60 * 1000
const TIMEOUT_MS = 12_000
const MAX_PAGES = 100

export type ModelSource = "api" | "cache" | "unavailable"
export type ModelList = {
  ids: string[]
  source: ModelSource
  endpoint: string
  checkedAt?: number
  stale?: boolean
  error?: string
}

type Entry = { ids: string[]; at: number; scope: string }
type DiskCache = { version: 2; providers: Partial<Record<ProviderName, Entry>> }
const memory = new Map<string, Entry>()
const results = new Map<string, ModelList>()
const pending = new Map<string, Promise<ModelList>>()
class DiscoveryError extends Error {}

export function modelEndpoint(provider: ProviderName): string {
  switch (provider) {
    case "openai": return "https://api.openai.com/v1/models"
    case "deepseek": return "https://api.deepseek.com/models"
    case "anthropic": return "https://api.anthropic.com/v1/models?limit=100"
    case "chatgpt": {
      const version = process.env.STACKY_CODEX_CLIENT_VERSION ?? CODEX_MODELS_CLIENT_VERSION
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new DiscoveryError("STACKY_CODEX_CLIENT_VERSION must be a semantic version, e.g. 0.162.1.")
      return `${CHATGPT_BASE_URL}/models?client_version=${version}`
    }
  }
}

function diskPath(): string {
  return process.env.STACKY_MODELS ?? join(homedir(), ".config", "stacky", "models.json")
}

/** Cache identities contain hashes, never API keys or bearer/refresh tokens. */
function scopeFor(provider: ProviderName, endpoint: string): string | undefined {
  let identity: string | undefined
  if (provider === "chatgpt") {
    const auth = loadAuth()
    if (auth?.access_token || auth?.refresh_token) identity = auth.account_id || auth.refresh_token || auth.access_token
  } else identity = process.env[apiKeyEnvName(provider)]
  if (!identity) return undefined
  return createHash("sha256").update(`${provider}\0${endpoint}\0${identity}`).digest("hex")
}

function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 1024 && !/[\s\u0000-\u001f\u007f-\u009f]/.test(id)
}

function readDisk(path: string): DiskCache {
  const empty: DiskCache = { version: 2, providers: {} }
  try {
    const body = JSON.parse(readFileSync(path, "utf8")) as DiskCache
    // Older, unscoped caches may belong to a different account. Never import them.
    if (body?.version !== 2 || !body.providers || typeof body.providers !== "object") return empty
    for (const provider of ["openai", "deepseek", "anthropic", "chatgpt"] as const) {
      const entry = body.providers[provider]
      if (entry && /^[a-f0-9]{64}$/.test(entry.scope) && Number.isFinite(entry.at) && entry.at >= 0 && entry.at <= Date.now() + 60_000 && Array.isArray(entry.ids) && entry.ids.every(validId)) {
        empty.providers[provider] = entry
      }
    }
  } catch { /* No verified cache is better than an invented list. */ }
  return empty
}

function writeDisk(path: string, provider: ProviderName, entry: Entry): void {
  try {
    const all = readDisk(path)
    all.providers[provider] = entry
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch { /* Discovery still succeeds on a read-only filesystem. */ }
}

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DiscoveryError("Invalid models response: expected a JSON object.")
  return body as Record<string, unknown>
}

/** Parse each provider's documented shape; no guessing from display names. */
export function parseModelIds(provider: ProviderName, body: unknown): string[] {
  const record = object(body)
  const field = provider === "chatgpt" ? "models" : "data"
  const rows = record[field]
  if (!Array.isArray(rows)) throw new DiscoveryError(`Invalid models response: expected ${field}[].`)
  const models = rows.map((row) => {
    const model = object(row)
    const id = provider === "chatgpt" ? model.slug : model.id
    if (!validId(id)) throw new DiscoveryError(`Invalid models response: missing or invalid ${provider === "chatgpt" ? "slug" : "id"}.`)
    return { id, visibility: model.visibility, priority: typeof model.priority === "number" && Number.isFinite(model.priority) ? model.priority : 0 }
  })
  // Codex's OAuth picker uses visibility and priority; supported_in_api applies
  // only to API-key mode and must NOT remove subscription-only models here.
  const listed = provider === "chatgpt"
    ? models.filter((model) => model.visibility === undefined || model.visibility === "list").sort((a, b) => a.priority - b.priority)
    : models
  return [...new Set(listed.map((model) => model.id))]
}

async function headersFor(provider: ProviderName, signal: AbortSignal): Promise<Headers> {
  const headers = new Headers({ accept: "application/json" })
  if (provider === "chatgpt") {
    try {
      const auth = await ensureFreshAuth(60_000, signal)
      if (!auth.access_token) throw new Error("missing access token")
      headers.set("authorization", `Bearer ${auth.access_token}`)
      if (auth.account_id) headers.set("chatgpt-account-id", auth.account_id)
      headers.set("originator", "stacky")
    } catch (error) {
      const reason = error instanceof OAuthResponseError ? error.message : "ChatGPT authentication failed or expired."
      throw new DiscoveryError(`${reason} Run /login chatgpt, then /model refresh chatgpt.`)
    }
  } else {
    const key = process.env[apiKeyEnvName(provider)]
    if (!key) throw new DiscoveryError(`Missing ${apiKeyEnvName(provider)}.`)
    if (provider === "anthropic") {
      headers.set("x-api-key", key)
      headers.set("anthropic-version", "2023-06-01")
    } else headers.set("authorization", `Bearer ${key}`)
  }
  return headers
}

async function requestJson(url: URL, headers: Headers, signal: AbortSignal): Promise<Record<string, unknown>> {
  // Never forward credentials to a redirect/consent gateway, and never parse its
  // HTML as though it were a provider response.
  const response = await fetch(url, { headers, signal, redirect: "manual" })
  if (response.status >= 300 && response.status < 400) {
    let host = "another host"
    try { host = new URL(response.headers.get("location") ?? "", url).hostname } catch { /* redact malformed Location */ }
    throw new DiscoveryError(`HTTP ${response.status}: ${url.hostname} redirected to ${host}. Provider JSON was not received. Check your network gateway's API-access policy, then retry.`)
  }
  if (!response.ok) {
    const help = response.status === 401 || response.status === 403 ? " Check the provider credentials and account access." : response.status === 429 ? " Rate limited; retry later." : ""
    throw new DiscoveryError(`HTTP ${response.status} from ${url.hostname}.${help}`)
  }
  const contentType = response.headers.get("content-type") ?? ""
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
    throw new DiscoveryError(`Non-JSON response from ${url.hostname}${/html/i.test(contentType) ? " (HTML, possibly a network gateway page)" : ""}. Model discovery failed.`)
  }
  let body: unknown
  try { body = await response.json() } catch { throw new DiscoveryError(`Invalid JSON from ${url.hostname}.`) }
  return object(body)
}

async function discover(provider: ProviderName, endpoint: string, headers: Headers, signal: AbortSignal): Promise<string[]> {
  const url = new URL(endpoint)
  const ids = new Set<string>()
  const cursors = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await requestJson(url, headers, signal)
    for (const id of parseModelIds(provider, body)) ids.add(id)
    // OpenAI and DeepSeek models.list are not paginated. Anthropic is, and a
    // successful first page alone is not a complete model list.
    if (provider !== "anthropic") return [...ids]
    if (typeof body.has_more !== "boolean") throw new DiscoveryError("Invalid Anthropic models response: missing has_more.")
    if (!body.has_more) return [...ids]
    const cursor = body.last_id
    if (!validId(cursor) || cursors.has(cursor)) throw new DiscoveryError("Anthropic model pagination returned a missing or repeated last_id; list is incomplete.")
    cursors.add(cursor)
    url.searchParams.set("after_id", cursor)
  }
  throw new DiscoveryError("Model pagination exceeded its safety limit; list is incomplete.")
}

function identity(provider: ProviderName) {
  const endpoint = modelEndpoint(provider)
  const scope = scopeFor(provider, endpoint)
  const path = diskPath()
  const key = `${path}\0${provider}\0${scope ?? "unauthenticated"}`
  let cached = scope ? memory.get(key) : undefined
  if (scope && !cached) {
    const disk = readDisk(path).providers[provider]
    if (disk?.scope === scope) { cached = disk; memory.set(key, disk) }
  }
  return { endpoint, scope, path, key, cached }
}

function unauthenticated(provider: ProviderName, endpoint: string): ModelList {
  return { ids: [], source: "unavailable", endpoint, error: provider === "chatgpt" ? "Not signed in. Run /login chatgpt." : `Missing ${apiKeyEnvName(provider)}.` }
}

/** Live discovery or an explicitly labelled, account-scoped last-success cache. */
export async function listModels(provider: ProviderName, options: { force?: boolean } = {}): Promise<ModelList> {
  let context: ReturnType<typeof identity>
  try { context = identity(provider) } catch (error) {
    return { ids: [], source: "unavailable", endpoint: CHATGPT_BASE_URL + "/models", error: error instanceof DiscoveryError ? error.message : "Invalid discovery configuration." }
  }
  const { endpoint, scope, path, key, cached } = context
  if (!scope) return unauthenticated(provider, endpoint)
  const now = Date.now()
  if (!options.force && cached && now >= cached.at && now - cached.at < TTL_MS) {
    const last = results.get(key)
    if (last?.source === "cache" && last.error && last.checkedAt === cached.at) return last
    return { ids: cached.ids, source: "cache", endpoint, checkedAt: cached.at, stale: false }
  }
  const existing = pending.get(key)
  if (existing) return existing
  const job = (async (): Promise<ModelList> => {
    let result: ModelList
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    try {
      const headers = await headersFor(provider, signal)
      const ids = await discover(provider, endpoint, headers, signal)
      const at = Date.now()
      const entry: Entry = { ids, at, scope }
      if (scopeFor(provider, endpoint) === scope) {
        memory.set(key, entry)
        writeDisk(path, provider, entry)
      }
      result = { ids, source: "api", endpoint, checkedAt: at, stale: false }
    } catch (error) {
      const reason = signal.aborted ? "Model discovery timed out after 12s." : error instanceof DiscoveryError ? error.message : "Network request failed before provider JSON was received. Check network access and TLS configuration."
      result = cached
        ? { ids: cached.ids, source: "cache", endpoint, checkedAt: cached.at, stale: true, error: reason }
        : { ids: [], source: "unavailable", endpoint, error: reason }
    }
    results.set(key, result)
    return result
  })()
  pending.set(key, job)
  try { return await job } finally { pending.delete(key) }
}

/** Shared discovery state for menus and completion, including the actual failure. */
export function modelListSnapshot(provider: ProviderName): ModelList {
  try {
    const { endpoint, scope, key, cached } = identity(provider)
    if (!scope) return unauthenticated(provider, endpoint)
    const last = results.get(key)
    if (last) {
      if (last.source === "api" && last.checkedAt !== undefined && Date.now() - last.checkedAt >= TTL_MS) {
        return { ...last, source: "cache", stale: true }
      }
      return last
    }
    if (cached) return { ids: cached.ids, source: "cache", endpoint, checkedAt: cached.at, stale: Date.now() - cached.at >= TTL_MS }
    return { ids: [], source: "unavailable", endpoint }
  } catch { return { ids: [], source: "unavailable", endpoint: CHATGPT_BASE_URL + "/models", error: "Invalid discovery configuration." } }
}

/** Never supplies hardcoded catalog entries. */
export function cachedModels(provider: ProviderName): string[] {
  return modelListSnapshot(provider).ids
}

export function clearModelCache(provider?: ProviderName): void {
  for (const map of [memory, results]) {
    for (const key of map.keys()) if (!provider || key.split("\0")[1] === provider) map.delete(key)
  }
}
