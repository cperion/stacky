import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  accountIdFromIdToken,
  authorizeUrl,
  clearAuth,
  ensureFreshAuth,
  loadAuth,
  pkcePair,
  saveAuth,
  tokensFromResponse,
} from "../src/llm/oauth.ts"

let dir: string | undefined
function tempAuthPath(): void {
  dir = mkdtempSync(join(tmpdir(), "stacky-auth-"))
  process.env.STACKY_AUTH = join(dir, "auth.json")
}
afterEach(() => {
  delete process.env.STACKY_AUTH
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const JWT = [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })).toString("base64url"),
  "sig",
].join(".")

describe("pkce", () => {
  test("challenge is the S256 hash of the verifier", () => {
    const { verifier, challenge } = pkcePair()
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"))
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test("authorize url carries the PKCE + scope parameters", () => {
    const url = new URL(authorizeUrl("chal", "st"))
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.openai.com/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBeTruthy()
    expect(url.searchParams.get("code_challenge")).toBe("chal")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("st")
    expect(url.searchParams.get("scope")).toContain("offline_access")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
  })
})

describe("tokens", () => {
  test("reads the chatgpt account id from the id token", () => {
    expect(accountIdFromIdToken(JWT)).toBe("acct_123")
    expect(accountIdFromIdToken(undefined)).toBeUndefined()
  })

  test("builds an auth record with an expiry", () => {
    const auth = tokensFromResponse({ access_token: "a", refresh_token: "r", expires_in: 100, id_token: JWT })
    expect(auth.access_token).toBe("a")
    expect(auth.refresh_token).toBe("r")
    expect(auth.account_id).toBe("acct_123")
    expect(auth.expires_at).toBeGreaterThan(Date.now())
  })

  test("throws without an access token", () => {
    expect(() => tokensFromResponse({})).toThrow(/access_token/)
  })
})

describe("auth store", () => {
  test("round-trips through disk and clears", () => {
    tempAuthPath()
    expect(loadAuth()).toBeUndefined()
    saveAuth({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 60_000 })
    expect(loadAuth()?.refresh_token).toBe("r")
    clearAuth()
    expect(loadAuth()).toBeUndefined()
  })
})

describe("ensureFreshAuth", () => {
  test("errors when not signed in", async () => {
    tempAuthPath()
    await expect(ensureFreshAuth()).rejects.toThrow(/login/i)
  })

  test("returns a still-valid token untouched", async () => {
    tempAuthPath()
    saveAuth({ access_token: "fresh", refresh_token: "r", expires_at: Date.now() + 10 * 60_000 })
    expect((await ensureFreshAuth()).access_token).toBe("fresh")
  })

  test("refreshes and persists an expired token", async () => {
    tempAuthPath()
    saveAuth({ access_token: "old", refresh_token: "r", expires_at: Date.now() - 1_000 })
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "new", refresh_token: "r2", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    try {
      const fresh = await ensureFreshAuth()
      expect(fresh.access_token).toBe("new")
      expect(loadAuth()?.access_token).toBe("new")
    } finally {
      globalThis.fetch = original
    }
  })
})
