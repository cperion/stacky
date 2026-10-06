import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime } from "../src/agent/runtime.ts"
import { ScriptedLLM } from "../src/llm/scripted.ts"
import type { AgentState, StreamingState } from "../src/agent/types.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-stream-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function makeRuntime(steps: ConstructorParameters<typeof ScriptedLLM>[0]) {
  return new AgentRuntime({ cwd: dir, llm: new ScriptedLLM(steps), maxStepsPerRun: 30 })
}

describe("streaming", () => {
  test("reasoning deltas are visible live and persisted as a thinking entry", async () => {
    const observed: StreamingState[] = []
    const runtime = makeRuntime([
      (_input, handlers) => {
        handlers?.onReasoningDelta?.("Let me think. ")
        handlers?.onReasoningDelta?.("I will push a frame.")
        return {
          tool: "push",
          input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] },
        }
      },
      { tool: "user", input: { message: "ok", response: "none" } },
    ])

    runtime.bus.on((event) => {
      if (event.type === "state.changed") {
        const streaming = runtime.snapshot().streaming
        if (streaming) observed.push(streaming)
      }
    })

    await runtime.request("go")

    // Deltas were surfaced incrementally while the call was in flight.
    expect(observed.some((s) => s.reasoning.includes("Let me think"))).toBe(true)

    // Once finished, the buffer is cleared and reasoning becomes a conversation entry.
    const state = runtime.snapshot()
    expect(state.streaming).toBeUndefined()
    const thinking = state.conversation.filter((entry) => entry.role === "thinking")
    expect(thinking).toHaveLength(1)
    expect(thinking[0]?.text).toBe("Let me think. I will push a frame.")
  })

  test("thinking entries are excluded from the model prompt", async () => {
    let sawPrompt = ""
    const runtime = makeRuntime([
      (_input, handlers) => {
        handlers?.onReasoningDelta?.("SECRET_REASONING")
        return { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } }
      },
      (input) => {
        sawPrompt = input.prompt
        return { tool: "user", input: { message: "done", response: "none" } }
      },
    ])
    await runtime.request("go")
    expect(sawPrompt).not.toContain("SECRET_REASONING")
  })

  test("text deltas are streamed but not persisted as assistant output", async () => {
    const seen: string[] = []
    const runtime = makeRuntime([
      (_input, handlers) => {
        handlers?.onTextDelta?.("thinking out loud")
        return { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } }
      },
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    runtime.bus.on((event) => {
      if (event.type === "state.changed") {
        const text = runtime.snapshot().streaming?.text
        if (text) seen.push(text)
      }
    })
    await runtime.request("go")
    expect(seen.some((t) => t.includes("thinking out loud"))).toBe(true)
    const state: AgentState = runtime.snapshot()
    expect(state.conversation.some((e) => e.role === "agent" && e.text.includes("thinking out loud"))).toBe(false)
  })
})

describe("runtime settings", () => {
  test("setLLM swaps the model label", () => {
    const runtime = makeRuntime([{ tool: "user", input: { message: "x", response: "none" } }])
    expect(runtime.llmLabel).toBe("scripted")
    runtime.setLLM(new ScriptedLLM([], undefined, "deepseek/deepseek-flash"))
    expect(runtime.llmLabel).toBe("deepseek/deepseek-flash")
  })

  test("setBudgets evicts files and shrinks conversation", async () => {
    const runtime = makeRuntime([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "bash", input: { command: "true" } },
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    const before = runtime.snapshot().conversation.length
    const evicted = runtime.setBudgets({ fileBudgetTokens: 10, conversationBudgetTokens: 5 })
    expect(Array.isArray(evicted)).toBe(true)
    expect(runtime.snapshot().conversation.length).toBeLessThan(before)
  })

  test("reset clears stack, conversation and files", async () => {
    const runtime = makeRuntime([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    expect(runtime.snapshot().stack).toHaveLength(1)
    runtime.reset()
    const state = runtime.snapshot()
    expect(state.stack).toHaveLength(0)
    expect(state.conversation).toHaveLength(0)
    expect(state.mode).toBe("push")
  })
})
