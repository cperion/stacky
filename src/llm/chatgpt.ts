import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import { CHATGPT_BASE_URL, ensureFreshAuth } from "./oauth.ts"

/**
 * The ChatGPT subscription backend speaks the Responses API but lives on a
 * different host and needs OAuth + a couple of beta headers. We reuse the
 * OpenAI provider's Responses transport and inject a fresh token per request,
 * so long sessions survive token refresh mid-flight.
 */
export function createChatGptModel(modelId: string): LanguageModel {
  const provider = createOpenAI({
    apiKey: "chatgpt-oauth",
    baseURL: CHATGPT_BASE_URL,
    headers: {
      "OpenAI-Beta": "responses=experimental",
      originator: "stacky",
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = await ensureFreshAuth()
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${auth.access_token}`)
      headers.delete("openai-beta")
      headers.set("OpenAI-Beta", "responses=experimental")
      headers.set("originator", "stacky")
      if (auth.account_id) headers.set("chatgpt-account-id", auth.account_id)
      return fetch(input, { ...init, headers })
    }) as unknown as typeof fetch,
  })
  return provider.responses(modelId)
}
