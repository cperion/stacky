import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChatGptModel } from "../src/llm/chatgpt.ts"
import { saveAuth } from "../src/llm/oauth.ts"

const originalFetch = globalThis.fetch
const originalAuth = process.env.STACKY_AUTH
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-chatgpt-"))
  process.env.STACKY_AUTH = join(dir, "auth.json")
  saveAuth({ access_token: "test-access-secret", refresh_token: "test-refresh-secret", expires_at: Date.now() + 3_600_000, account_id: "test-account" })
})
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalAuth === undefined) delete process.env.STACKY_AUTH
  else process.env.STACKY_AUTH = originalAuth
  rmSync(dir, { recursive: true, force: true })
})

const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }]

test("ChatGPT sends mandatory stateless options through the real SDK serializer", async () => {
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses")
    const body = JSON.parse(init?.body as string)
    expect(body.store).toBe(false)
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.reasoning.summary).toBe("auto")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer test-access-secret")
    expect(headers.get("chatgpt-account-id")).toBe("test-account")
    expect(init?.redirect).toBe("manual")
    return new Response("", { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  const result = await createChatGptModel("gpt-5").doStream({
    prompt,
    providerOptions: { openai: { store: true, parallelToolCalls: true, reasoningSummary: "auto" } },
  })
  await result.stream.cancel()
})

test("Codex detail errors surface instead of generic Bad Request, without echoed credentials", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "Store must be set to false; test-access-secret test-refresh-secret" }), {
    status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch
  let error: Error | undefined
  try { await createChatGptModel("gpt-5").doStream({ prompt }) } catch (caught) { error = caught as Error }
  expect(error?.message).toContain("ChatGPT HTTP 400: Store must be set to false")
  expect(error?.message).not.toContain("test-access-secret")
  expect(error?.message).not.toContain("test-refresh-secret")
})

test("inference requests do not follow redirects with prompts or account headers", async () => {
  let calls = 0
  globalThis.fetch = (async (_url, init) => {
    calls += 1
    expect(init?.redirect).toBe("manual")
    return new Response(null, { status: 307, headers: { location: "https://gateway.example/policy?secret=hidden" } })
  }) as typeof fetch
  await expect(createChatGptModel("gpt-5").doStream({ prompt })).rejects.toThrow("redirected to gateway.example")
  expect(calls).toBe(1)
})
