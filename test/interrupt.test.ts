import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime } from "../src/agent/runtime.ts"
import type { LLMClient, ModelInput, StreamHandlers } from "../src/llm/client.ts"
import type { ModelAction } from "../src/stack/schemas.ts"

/** An LLM whose call blocks until the abort signal fires. */
class BlockingLLM implements LLMClient {
  readonly label = "blocking"
  started = false
  sawAbort = false

  async step(_input: ModelInput, _handlers?: StreamHandlers, signal?: AbortSignal): Promise<ModelAction> {
    this.started = true
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.sawAbort = true
        const error = new Error("The operation was aborted.")
        error.name = "AbortError"
        reject(error)
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      setTimeout(resolve, 5_000)
    })
    return { tool: "user", input: { message: "should not reach here", response: "none" } }
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-interrupt-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("interrupt", () => {
  test("aborts the in-flight model call and stops the run cleanly", async () => {
    const llm = new BlockingLLM()
    const runtime = new AgentRuntime({ cwd: dir, llm, maxStepsPerRun: 10 })

    const run = runtime.request("do something that takes forever")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(llm.started).toBe(true)
    expect(runtime.isRunning).toBe(true)

    expect(runtime.interrupt()).toBe(true)
    await run

    expect(llm.sawAbort).toBe(true)
    expect(runtime.isRunning).toBe(false)
    expect(runtime.isStreaming).toBe(false)
    const state = runtime.snapshot()
    expect(state.conversation.some((entry) => entry.role === "note" && entry.text.includes("interrupted"))).toBe(true)
    // No fatal/error request was raised.
    expect(state.userRequest).toBeUndefined()
  })

  test("interrupt() is a no-op when nothing is running", () => {
    const runtime = new AgentRuntime({ cwd: dir, llm: new BlockingLLM() })
    expect(runtime.interrupt()).toBe(false)
  })
})
