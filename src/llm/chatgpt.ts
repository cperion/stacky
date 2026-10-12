import { createOpenAI } from "@ai-sdk/openai"
import { wrapLanguageModel } from "ai"
import { CHATGPT_BASE_URL, ensureFreshAuth } from "./oauth.ts"

/**
 * The ChatGPT subscription backend speaks the Responses API but lives on a
 * different host and needs OAuth + a couple of beta headers. We reuse the
 * OpenAI provider's Responses transport, but Codex requires stateless requests:
 * store=false is mandatory, not the public OpenAI API's default.
 */
export function createChatGptModel(modelId: string) {
  const provider = createOpenAI({
    apiKey: "chatgpt-oauth",
    baseURL: CHATGPT_BASE_URL,
    headers: {
      "OpenAI-Beta": "responses=experimental",
      originator: "stacky",
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = await ensureFreshAuth(60_000, init?.signal ?? undefined)
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${auth.access_token}`)
      headers.delete("openai-beta")
      headers.set("OpenAI-Beta", "responses=experimental")
      headers.set("originator", "stacky")
      if (auth.account_id) headers.set("chatgpt-account-id", auth.account_id)
      const response = await fetch(input, { ...init, headers, redirect: "manual" })
      if (response.status >= 300 && response.status < 400) {
        let host = "another endpoint"
        try { host = new URL(response.headers.get("location") ?? "", CHATGPT_BASE_URL).hostname } catch {}
        await response.body?.cancel()
        throw new Error(`ChatGPT HTTP ${response.status}: redirected to ${host}. Request was not forwarded; check gateway API access.`)
      }
      // Codex often returns {detail: "..."}, whereas the SDK understands
      // {error: {message: "..."}}. Preserve status/retry handling, not just "Bad Request".
      if (!response.ok) {
        const body = await response.clone().json().catch(() => undefined)
        if (typeof body?.detail === "string") {
          let message = body.detail as string
          for (const secret of [auth.access_token, auth.refresh_token]) {
            if (secret) message = message.split(secret).join("[redacted]")
          }
          message = message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000)
          const responseHeaders = new Headers(response.headers)
          responseHeaders.set("content-type", "application/json")
          responseHeaders.delete("content-length")
          responseHeaders.delete("content-encoding")
          await response.body?.cancel()
          return new Response(JSON.stringify({ error: { message: `ChatGPT HTTP ${response.status}: ${message}` } }), {
            status: response.status, statusText: response.statusText, headers: responseHeaders,
          })
        }
      }
      return response
    }) as unknown as typeof fetch,
  })
  return wrapLanguageModel({
    model: provider.responses(modelId),
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: { ...params.providerOptions?.openai, store: false, parallelToolCalls: false },
        },
      }),
    },
  })
}
