import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cachedModels, clearModelCache, CODEX_MODELS_CLIENT_VERSION, listModels, modelEndpoint, modelListSnapshot, parseModelIds } from "../src/llm/models.ts"
import { clearAuth, loadAuth, saveAuth } from "../src/llm/oauth.ts"
import { formatModelList } from "../src/tui/model-list.ts"

let dir: string
const originalFetch = globalThis.fetch
const keys = ["STACKY_MODELS", "STACKY_AUTH", "STACKY_CODEX_CLIENT_VERSION", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY"]
const originalEnv = new Map(keys.map((key) => [key, process.env[key]]))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const mockFetch = (fn: (url: URL | RequestInfo, init?: RequestInit) => Promise<Response>) => { globalThis.fetch = fn as typeof fetch }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-discovery-"))
  process.env.STACKY_MODELS = join(dir, "models.json")
  process.env.STACKY_AUTH = join(dir, "auth.json")
  delete process.env.STACKY_CODEX_CLIENT_VERSION
  process.env.OPENAI_API_KEY = "openai-test-secret"
  process.env.DEEPSEEK_API_KEY = "deepseek-test-secret"
  process.env.ANTHROPIC_API_KEY = "anthropic-test-secret"
  saveAuth({ access_token: "oauth-test-secret", refresh_token: "refresh-test-secret", account_id: "account-one", expires_at: Date.now() + 3_600_000 })
  clearModelCache()
  mockFetch(async () => { throw new Error("Unexpected request — no real network in tests") })
})
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearModelCache()
  rmSync(dir, { recursive: true, force: true })
})

describe("provider discovery contracts", () => {
  for (const provider of ["openai", "deepseek"] as const) {
    test(`${provider}: canonical endpoint, bearer auth, API order and no injected catalog ids`, async () => {
      mockFetch(async (input, init) => {
        expect(String(input)).toBe(provider === "openai" ? "https://api.openai.com/v1/models" : "https://api.deepseek.com/models")
        const headers = new Headers(init?.headers)
        expect(headers.get("authorization")).toBe(`Bearer ${provider}-test-secret`)
        expect(headers.get("accept")).toBe("application/json")
        expect(init?.redirect).toBe("manual")
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return json({ object: "list", data: [{ id: "brand-new-model" }, { id: "older-model" }] })
      })
      const list = await listModels(provider, { force: true })
      expect(list.source).toBe("api")
      expect(list.ids).toEqual(["brand-new-model", "older-model"])
      expect(cachedModels(provider)).toEqual(list.ids)
    })
  }

  test("Anthropic follows every has_more/last_id page using after_id", async () => {
    const urls: string[] = []
    mockFetch(async (input, init) => {
      const url = new URL(String(input))
      urls.push(url.toString())
      expect(url.origin + url.pathname).toBe("https://api.anthropic.com/v1/models")
      expect(url.searchParams.get("limit")).toBe("100")
      const headers = new Headers(init?.headers)
      expect(headers.get("x-api-key")).toBe("anthropic-test-secret")
      expect(headers.get("anthropic-version")).toBe("2023-06-01")
      expect(headers.has("authorization")).toBe(false)
      return urls.length === 1
        ? json({ data: [{ id: "claude-new" }], first_id: "claude-new", last_id: "claude-new", has_more: true })
        : json({ data: [{ id: "claude-old" }], first_id: "claude-old", last_id: "claude-old", has_more: false })
    })
    const list = await listModels("anthropic", { force: true })
    expect(list.source).toBe("api")
    expect(list.ids).toEqual(["claude-new", "claude-old"])
    expect(new URL(urls[0]!).searchParams.has("after_id")).toBe(false)
    expect(new URL(urls[1]!).searchParams.get("after_id")).toBe("claude-new")
  })

  test("ChatGPT uses Codex models + client_version and OAuth account headers, not the OpenAI key", async () => {
    mockFetch(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/models")
      expect(url.searchParams.get("client_version")).toBe(CODEX_MODELS_CLIENT_VERSION)
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer oauth-test-secret")
      expect(headers.get("chatgpt-account-id")).toBe("account-one")
      expect(headers.get("originator")).toBe("stacky")
      return json({ models: [
        { slug: "lower-priority", priority: 9, visibility: "list", supported_in_api: true },
        { slug: "hidden-model", priority: 0, visibility: "hide" },
        { slug: "subscription-only", priority: 1, visibility: "list", supported_in_api: false },
      ] })
    })
    const list = await listModels("chatgpt", { force: true })
    expect(list.source).toBe("api")
    expect(list.ids).toEqual(["subscription-only", "lower-priority"])
  })

  test("expired ChatGPT auth is refreshed before the model API request", async () => {
    saveAuth({ access_token: "expired", refresh_token: "refresh-test-secret", account_id: "account-one", expires_at: Date.now() - 1 })
    const calls: string[] = []
    mockFetch(async (input, init) => {
      const url = String(input)
      calls.push(url)
      if (url === "https://auth.openai.com/oauth/token") {
        expect(JSON.parse(String(init?.body)).grant_type).toBe("refresh_token")
        expect(init?.redirect).toBe("manual")
        return json({ access_token: "renewed", expires_in: 3600 })
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer renewed")
      return json({ models: [{ slug: "fresh-subscription-model", visibility: "list" }] })
    })
    expect((await listModels("chatgpt")).ids).toEqual(["fresh-subscription-model"])
    expect(calls.length).toBe(2)
    expect(cachedModels("chatgpt")).toEqual(["fresh-subscription-model"])
  })

  test("OAuth refresh redirects report the gateway instead of hiding it as a credential failure", async () => {
    saveAuth({ access_token: "expired", refresh_token: "old-refresh", account_id: "account-one", expires_at: 0 })
    mockFetch(async () => new Response(null, { status: 307, headers: { location: "https://gateway.zscloud.net/consent?token=private" } }))
    const list = await listModels("chatgpt")
    expect(list.error).toContain("OAuth HTTP 307")
    expect(list.error).toContain("gateway.zscloud.net")
    expect(list.error).not.toContain("private")
    expect(list.ids).toEqual([])
  })

  test("logout during OAuth refresh cannot resurrect credentials or expose cached models", async () => {
    saveAuth({ access_token: "expired", refresh_token: "old-refresh", account_id: "account-one", expires_at: 0 })
    let finish!: (response: Response) => void
    let calls = 0
    mockFetch(async () => { calls++; return new Promise<Response>((resolve) => { finish = resolve }) })
    const pending = listModels("chatgpt")
    await Promise.resolve()
    clearAuth()
    finish(json({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 }))
    const list = await pending
    expect(list.source).toBe("unavailable")
    expect(loadAuth()).toBeUndefined()
    expect(cachedModels("chatgpt")).toEqual([])
    expect(calls).toBe(1)
  })

  test("compatibility version can be updated without changing model ids", () => {
    process.env.STACKY_CODEX_CLIENT_VERSION = "1.2.3"
    expect(modelEndpoint("chatgpt")).toEndWith("?client_version=1.2.3")
  })

  test("does not invent IDs from display names or accept a different provider's envelope", () => {
    expect(() => parseModelIds("openai", { data: [{ name: "not-an-id" }] })).toThrow("invalid id")
    expect(() => parseModelIds("chatgpt", { data: [{ id: "not-a-codex-response" }] })).toThrow("models[]")
    expect(() => parseModelIds("anthropic", ["not-an-envelope"])).toThrow("JSON object")
    expect(() => parseModelIds("deepseek", { data: [{ id: "bad\u001b[31m" }] })).toThrow("invalid id")
  })

  test("an empty API list is a successful empty list, not a catalog fallback", async () => {
    mockFetch(async () => json({ data: [] }))
    const list = await listModels("openai")
    expect(list.source).toBe("api")
    expect(list.ids).toEqual([])
    expect(formatModelList("openai", list)).toContain("provider returned no listed models")
  })
})

describe("failures are visible, not replaced by static models", () => {
  test("redirected consent gateways are reported without following or exposing query tokens", async () => {
    let calls = 0
    mockFetch(async (_url, init) => {
      calls++
      expect(init?.redirect).toBe("manual")
      return new Response(null, { status: 307, headers: { location: "https://gateway.zscloud.net/_sm_ccik?secret=private-query" } })
    })
    const list = await listModels("deepseek", { force: true })
    expect(calls).toBe(1)
    expect(list.source).toBe("unavailable")
    expect(list.ids).toEqual([])
    expect(list.error).toContain("HTTP 307")
    expect(list.error).toContain("gateway.zscloud.net")
    expect(list.error).not.toContain("private-query")
    expect(cachedModels("deepseek")).toEqual([])
    expect(formatModelList("deepseek", list)).toContain("gateway.zscloud.net")
    expect(modelListSnapshot("deepseek").error).toBe(list.error)
  })

  test("HTTP 200 HTML is a discovery error, not an empty API response", async () => {
    mockFetch(async () => new Response("<html>Network consent</html>", { headers: { "content-type": "text/html" } }))
    const list = await listModels("openai")
    expect(list.source).toBe("unavailable")
    expect(list.error).toContain("HTML")
    expect(list.ids).toEqual([])
  })

  test("401 gives an actionable auth error without exposing the response body", async () => {
    mockFetch(async () => json({ error: "private server diagnostics" }, 401))
    const list = await listModels("openai")
    expect(list.error).toContain("HTTP 401")
    expect(list.error).toContain("credentials")
    expect(list.error).not.toContain("private server")
    expect(list.ids).toEqual([])
  })

  test("missing credentials skip the network and return no guessed ids", async () => {
    delete process.env.OPENAI_API_KEY
    let calls = 0
    mockFetch(async () => { calls++; return json({ data: [] }) })
    const list = await listModels("openai")
    expect(calls).toBe(0)
    expect(list.error).toContain("OPENAI_API_KEY")
    expect(list.ids).toEqual([])
  })

  test("page two failure does not publish or cache a partial Anthropic catalog", async () => {
    let calls = 0
    mockFetch(async () => ++calls === 1
      ? json({ data: [{ id: "partial-model" }], has_more: true, last_id: "partial-model" })
      : json({}, 503))
    const list = await listModels("anthropic", { force: true })
    expect(calls).toBe(2)
    expect(list.source).toBe("unavailable")
    expect(list.ids).toEqual([])
    expect(cachedModels("anthropic")).toEqual([])
  })

  test("repeated pagination cursors fail instead of looping forever", async () => {
    let calls = 0
    mockFetch(async () => { calls++; return json({ data: [{ id: "same" }], has_more: true, last_id: "same" }) })
    const list = await listModels("anthropic")
    expect(calls).toBe(2)
    expect(list.error).toContain("repeated last_id")
    expect(list.ids).toEqual([])
  })

  test("invalid JSON does not expose its raw body", async () => {
    mockFetch(async () => new Response("private-invalid-body", { headers: { "content-type": "application/json" } }))
    const list = await listModels("openai")
    expect(list.error).toContain("Invalid JSON")
    expect(list.error).not.toContain("private-invalid-body")
  })
})

describe("only successful API responses enter the account-scoped cache", () => {
  test("memory/disk cache is labelled, and force actually refetches", async () => {
    let calls = 0
    mockFetch(async () => json({ data: [{ id: `new-model-${++calls}` }] }))
    expect((await listModels("openai")).source).toBe("api")
    expect((await listModels("openai")).source).toBe("cache")
    clearModelCache()
    expect((await listModels("openai")).ids).toEqual(["new-model-1"])
    expect(calls).toBe(1)
    expect((await listModels("openai", { force: true })).ids).toEqual(["new-model-2"])
    expect(calls).toBe(2)
    expect(readFileSync(process.env.STACKY_MODELS!, "utf8")).not.toContain("openai-test-secret")
  })

  test("expired memory snapshots are labelled stale and expired disk entries are refetched", async () => {
    const originalNow = Date.now
    let calls = 0
    mockFetch(async () => json({ data: [{ id: `version-${++calls}` }] }))
    await listModels("openai")
    const later = originalNow() + 10 * 60_000 + 1
    try {
      Date.now = () => later
      expect(modelListSnapshot("openai").source).toBe("cache")
      expect(modelListSnapshot("openai").stale).toBe(true)
      clearModelCache()
      expect((await listModels("openai")).source).toBe("api")
      expect(calls).toBe(2)
    } finally { Date.now = originalNow }
  })

  test("failed refresh retains a timestamped API cache and surfaces the failure", async () => {
    mockFetch(async () => json({ data: [{ id: "verified-earlier" }] }))
    const first = await listModels("openai")
    mockFetch(async () => { throw new Error("private network debug details") })
    const list = await listModels("openai", { force: true })
    expect(list.source).toBe("cache")
    expect(list.stale).toBe(true)
    expect(list.ids).toEqual(["verified-earlier"])
    expect(list.checkedAt).toBe(first.checkedAt)
    expect(list.error).toContain("Network request failed")
    expect(list.error).not.toContain("private network")
    expect(formatModelList("openai", list)).toContain("refresh FAILED")
  })

  test("changing API keys or logging out does not reuse another account's models", async () => {
    mockFetch(async () => json({ data: [{ id: "private-finetune" }] }))
    await listModels("openai")
    process.env.OPENAI_API_KEY = "another-account"
    expect(cachedModels("openai")).toEqual([])
    mockFetch(async () => json({}, 403))
    expect((await listModels("openai")).ids).toEqual([])
    delete process.env.OPENAI_API_KEY
    expect(cachedModels("openai")).toEqual([])
  })

  test("changing ChatGPT accounts separates model lists", async () => {
    mockFetch(async () => json({ models: [{ slug: "plan-one-model", visibility: "list" }] }))
    await listModels("chatgpt")
    saveAuth({ access_token: "account-two-token", refresh_token: "r2", account_id: "account-two", expires_at: Date.now() + 3_600_000 })
    expect(cachedModels("chatgpt")).toEqual([])
  })

  test("legacy and malformed caches never resurrect the hardcoded list", () => {
    for (const contents of ['{"openai":{"ids":["old-catalog-id"],"at":1}}', 'null', '{"version":2,"providers":{"openai":{"ids":[null],"at":0,"scope":"bad"}}}']) {
      writeFileSync(process.env.STACKY_MODELS!, contents)
      expect(cachedModels("openai")).toEqual([])
    }
  })

  test("concurrent discovery shares the same actual request", async () => {
    let calls = 0
    let finish!: (response: Response) => void
    mockFetch(async () => { calls++; return new Promise<Response>((resolve) => { finish = resolve }) })
    const first = listModels("openai", { force: true })
    const second = listModels("openai", { force: true })
    await Promise.resolve()
    finish(json({ data: [{ id: "new-model" }] }))
    expect((await first).ids).toEqual(["new-model"])
    expect((await second).ids).toEqual(["new-model"])
    expect(calls).toBe(1)
  })
})
