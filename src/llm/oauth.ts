import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * ChatGPT (subscription) OAuth — the "Sign in with ChatGPT" flow, so the agent
 * can run against a ChatGPT plan instead of an OpenAI API key.
 *
 * PKCE: we send a code_challenge, the browser redirects back to a loopback
 * server with a code, and we exchange it for access/refresh tokens. Tokens live
 * in ~/.config/stacky/auth.json (0600) and are refreshed transparently.
 */
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
export const TOKEN_URL = "https://auth.openai.com/oauth/token"
export const REDIRECT_PORT = 1455
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`
export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex"

export type ChatGptAuth = {
  access_token: string
  refresh_token: string
  /** ms since epoch */
  expires_at: number
  account_id?: string
}

export function authPath(): string {
  return process.env.STACKY_AUTH ?? join(homedir(), ".config", "stacky", "auth.json")
}

export function loadAuth(): ChatGptAuth | undefined {
  try {
    const parsed = JSON.parse(readFileSync(authPath(), "utf8")) as Partial<ChatGptAuth>
    if (typeof parsed.access_token !== "string" && typeof parsed.refresh_token !== "string") return undefined
    return {
      access_token: parsed.access_token ?? "",
      refresh_token: parsed.refresh_token ?? "",
      expires_at: typeof parsed.expires_at === "number" ? parsed.expires_at : 0,
      ...(parsed.account_id ? { account_id: parsed.account_id } : {}),
    }
  } catch {
    return undefined
  }
}

export function saveAuth(auth: ChatGptAuth): void {
  const path = authPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
}

export function clearAuth(): void {
  rmSync(authPath(), { force: true })
}

export function hasChatGptAuth(): boolean {
  const auth = loadAuth()
  return Boolean(auth?.refresh_token || auth?.access_token)
}

/** PKCE verifier + S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export function authorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", "openid profile email offline_access")
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  url.searchParams.set("id_token_add_organizations", "true")
  url.searchParams.set("codex_cli_simplified_flow", "true")
  return url.toString()
}

function decodeJwt(token?: string): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1]
  if (!payload) return undefined
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function accountIdFromIdToken(idToken?: string): string | undefined {
  const claims = decodeJwt(idToken)
  const auth = claims?.["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined
}

export function tokensFromResponse(body: Record<string, unknown>, previous?: ChatGptAuth): ChatGptAuth {
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600
  const accessToken = typeof body.access_token === "string" ? body.access_token : previous?.access_token
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : previous?.refresh_token
  if (!accessToken) throw new Error("token response had no access_token")
  const accountId = accountIdFromIdToken(typeof body.id_token === "string" ? body.id_token : undefined)
  return {
    access_token: accessToken,
    refresh_token: refreshToken ?? "",
    expires_at: Date.now() + expiresIn * 1000,
    ...(accountId ?? previous?.account_id ? { account_id: accountId ?? previous?.account_id } : {}),
  }
}

export async function exchangeCode(code: string, verifier: string): Promise<ChatGptAuth> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })
  if (!response.ok) throw new Error(`token exchange failed: ${response.status} ${await response.text()}`)
  return tokensFromResponse((await response.json()) as Record<string, unknown>)
}

export async function refreshAuth(auth: ChatGptAuth): Promise<ChatGptAuth> {
  if (!auth.refresh_token) throw new Error("no refresh token; run /login chatgpt again")
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token,
      scope: "openid profile email",
    }),
  })
  if (!response.ok) throw new Error(`token refresh failed: ${response.status}`)
  const next = tokensFromResponse((await response.json()) as Record<string, unknown>, auth)
  saveAuth(next)
  return next
}

/** Access token guaranteed valid for at least `skewMs` from now. */
export async function ensureFreshAuth(skewMs = 60_000): Promise<ChatGptAuth> {
  const auth = loadAuth()
  if (!auth) throw new Error("Not signed in to ChatGPT. Run /login chatgpt.")
  if (auth.expires_at - Date.now() > skewMs) return auth
  if (!auth.refresh_token) return auth
  return refreshAuth(auth)
}

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref()
  } catch {
    // Headless: the caller prints the URL for the user to open manually.
  }
}

/** Run the browser login and persist the tokens. */
export async function loginWithBrowser(onUrl?: (url: string) => void): Promise<ChatGptAuth> {
  const { verifier, challenge } = pkcePair()
  const state = randomBytes(16).toString("base64url")
  const url = authorizeUrl(challenge, state)

  const server = createServer()
  const codePromise = new Promise<string>((resolve, reject) => {
    server.on("request", (request, response) => {
      const parsed = new URL(request.url ?? "/", REDIRECT_URI)
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<h1>stacky</h1><p>Signed in. You can close this tab.</p>")
      if (parsed.pathname !== "/auth/callback") return
      const error = parsed.searchParams.get("error")
      const code = parsed.searchParams.get("code")
      const returned = parsed.searchParams.get("state")
      if (error) reject(new Error(error))
      else if (returned !== state) reject(new Error("state mismatch"))
      else if (code) resolve(code)
      else reject(new Error("no authorization code"))
    })
    server.on("error", reject)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(REDIRECT_PORT, "127.0.0.1", resolve)
  })

  onUrl?.(url)
  openBrowser(url)
  try {
    const code = await codePromise
    const auth = await exchangeCode(code, verifier)
    saveAuth(auth)
    return auth
  } finally {
    server.close()
  }
}
