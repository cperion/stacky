import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_CATALOG } from "../src/llm/catalog.ts"
import { cachedModels, clearModelCache, listModels, parseModelIds, rankModels } from "../src/llm/models.ts"

let dir: string | undefined
const originalFetch = globalThis.fetch
const originalEnv = { STACKY_MODELS: process.env.STACKY_MODELS, OPENAI_API_KEY: process.env.OPENAI_API_KEY }

function isolate(): void {
  dir = mkdtempSync(join(tmpdir(), "stacky-models-"))
  process.env.STACKY_MODELS = join(dir, "models.json")
  process.env.OPENAI_API_KEY = "test-key"
}
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearModelCache()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("parseModelIds", () => {
  test("reads OpenAI data arrays", () => {
    expect(parseModelIds({ data: [{ id: "gpt-5" }, { id: "gpt-4o" }] })).toEqual(["gpt-5", "gpt-4o"])
  })
  test("reads slug/model/name objects and bare strings", () => {
    expect(parseModelIds({ models: [{ slug: "gpt-5-codex" }, "o4-mini", { name: "x" }] })).toEqual(["gpt-5-codex", "o4-mini", "x"])
  })
  test("reads a top-level array and dedupes", () => {
    expect(parseModelIds(["a", { id: "a" }, { id: "b" }])).toEqual(["a", "b"])
  })
  test("ignores junk", () => {
    expect(parseModelIds({ nothing: true })).toEqual([])
    expect(parseModelIds(null)).toEqual([])
  })
})

describe("rankModels", () => {
  test("puts known ids first, then the rest alphabetically", () => {
    expect(rankModels("openai", ["zzz", "gpt-5", "aaa", "gpt-4o-mini"])).toEqual(["gpt-4o-mini", "gpt-5", "aaa", "zzz"])
  })
})

describe("listModels", () => {
  test("fetches, ranks and reports the api as the source", async () => {
    isolate()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "zzz" }, { id: "gpt-4o-mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const result = await listModels("openai")
    expect(result.source).toBe("api")
    expect(result.ids).toEqual(["gpt-4o-mini", "zzz"])
    expect(cachedModels("openai")).toEqual(["gpt-4o-mini", "zzz"])
  })

  test("serves from cache within the TTL, force refetches", async () => {
    isolate()
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ data: [{ id: `m${calls}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    expect((await listModels("openai")).ids).toEqual(["m1"])
    expect((await listModels("openai")).ids).toEqual(["m1"])
    expect(calls).toBe(1)
    expect((await listModels("openai", { force: true })).ids).toEqual(["m2"])
    expect(calls).toBe(2)
  })

  test("falls back to the disk cache when the provider is unreachable", async () => {
    isolate()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    await listModels("openai") // writes the disk cache
    clearModelCache() // forget memory, keep disk
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const result = await listModels("openai", { force: true })
    expect(result.source).toBe("cache")
    expect(result.ids).toEqual(["gpt-4.1"])
    expect(result.stale).toBe(true)
    expect(result.error).toContain("unreachable")
  })

  test("fresh disk entries are cached, not claimed to be live", async () => {
    isolate()
    writeFileSync(process.env.STACKY_MODELS!, JSON.stringify({ openai: { ids: ["from-disk"], at: Date.now() } }))
    let calls = 0
    globalThis.fetch = (async () => { calls++; throw new Error("must not fetch") }) as unknown as typeof fetch
    const result = await listModels("openai")
    expect(result.source).toBe("cache")
    expect(result.stale).toBe(false)
    expect(result.ids).toEqual(["from-disk"])
    expect(calls).toBe(0)
  })

  test("malformed disk entries cannot crash completion", () => {
    isolate()
    writeFileSync(process.env.STACKY_MODELS!, '{"openai":{"ids":[null,42],"at":123}}')
    expect(cachedModels("openai")).toEqual(MODEL_CATALOG.openai)
    writeFileSync(process.env.STACKY_MODELS!, 'null')
    expect(cachedModels("openai")).toEqual(MODEL_CATALOG.openai)
  })

  test("uses the built-in catalog only as a last resort", async () => {
    isolate()
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const result = await listModels("openai")
    expect(result.source).toBe("catalog")
    expect(result.ids).toEqual(MODEL_CATALOG.openai)
  })

  test("skips the network entirely without a key", async () => {
    isolate()
    delete process.env.OPENAI_API_KEY
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const result = await listModels("openai")
    expect(called).toBe(false)
    expect(result.source).toBe("catalog")
  })
})
