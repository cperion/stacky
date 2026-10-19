import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime } from "../src/agent/runtime.ts"
import { readControlRecords } from "../src/agent/control.ts"
import { ScriptedLLM, type ScriptStep } from "../src/llm/scripted.ts"
import type { LLMClient, ModelInput, StreamHandlers } from "../src/llm/client.ts"
import type { ModelAction } from "../src/stack/schemas.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-retry-"))
  writeFileSync(join(dir, "a.txt"), "hello world")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function makeRuntime(steps: ScriptStep[], log = true): { runtime: AgentRuntime; logPath: string } {
  const runtime = new AgentRuntime({ cwd: dir, llm: new ScriptedLLM(steps), maxStepsPerRun: 20 })
  const logPath = join(dir, "session.control.jsonl")
  if (log) runtime.attachControlLog(logPath)
  return { runtime, logPath }
}

const pushFrame: ScriptStep = {
  tool: "push",
  input: {
    title: "Fix the greeting",
    why: "the greeting is wrong",
    scope: "a.txt",
    knownContext: "",
    definitionOfDone: "the greeting is correct",
    todos: ["inspect the file", "fix the greeting"],
  },
}

const reportSafely: ScriptStep = { tool: "user", input: { message: "paused for now", response: "none" } }

describe("fresh-context retry", () => {
  test("keeps the stack and closed frames, drops conversation and file views", async () => {
    const picked: ModelInput[] = []
    const capture: ScriptStep = (input: ModelInput) => {
      picked.push(input)
      return { tool: "bash", input: { command: "echo attempt-two" } }
    }
    const { runtime, logPath } = makeRuntime([
      pushFrame,
      { tool: "read", input: { path: "a.txt" } },
      reportSafely,
      capture,
      { tool: "bash", input: { command: "echo attempt-two-done" } },
      reportSafely,
    ])

    await runtime.request("please fix the greeting")
    const before = runtime.snapshot()
    expect(before.stack).toHaveLength(1)
    expect(before.files.map((file) => file.path)).toContain("a.txt")
    const frameId = before.stack[0]!.id

    const result = await runtime.retry()
    expect(result.ok).toBe(true)
    expect(result.message).toContain("fresh context")

    const after = runtime.snapshot()
    expect(after.stack).toHaveLength(1)
    expect(after.stack[0]!.id).toBe(frameId)
    expect(after.files).toHaveLength(0) // fresh attention
    expect(after.closedFrames).toHaveLength(before.closedFrames.length)
    expect(after.conversation.some((entry) => entry.text.includes("please fix the greeting"))).toBe(false)
    expect(after.conversation.some((entry) => entry.text.includes("↻ retry"))).toBe(true)

    // The second attempt's first prompt must not see the discarded conversation.
    expect(picked).toHaveLength(1)
    expect(picked[0]!.prompt).toContain("↻ retry")
    expect(picked[0]!.prompt).not.toContain("please fix the greeting")
    expect(picked[0]!.prompt).toContain("Fix the greeting")

    expect(readControlRecords(logPath).map((record) => record.kind)).toContain("retry")
  })

  test("refuses a retry after two attempts end in the same state, unless forced", async () => {
    const { runtime } = makeRuntime([pushFrame, reportSafely, reportSafely, reportSafely])

    await runtime.request("start")
    const first = await runtime.retry()
    expect(first.ok).toBe(true)

    const second = await runtime.retry()
    expect(second.ok).toBe(false)
    expect(second.message).toContain("No progress")
    expect(runtime.snapshot().conversation.some((entry) => entry.role === "note" && entry.text.includes("retry refused"))).toBe(true)

    const forced = await runtime.retry({ force: true, reason: "try a different angle" })
    expect(forced.ok).toBe(true)
  })

  test("retry is rejected with an empty stack, while running, or while paused", async () => {
    const { runtime } = makeRuntime([pushFrame, reportSafely])
    expect((await runtime.retry()).ok).toBe(false) // empty stack

    class BlockingLLM implements LLMClient {
      readonly label = "blocking"
      started = false
      async step(_input: ModelInput, _handlers?: StreamHandlers, signal?: AbortSignal): Promise<ModelAction> {
        this.started = true
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          if (signal?.aborted) return onAbort()
          signal?.addEventListener("abort", onAbort, { once: true })
        })
        return reportSafely as ModelAction
      }
    }
    const blocking = new BlockingLLM()
    const live = new AgentRuntime({ cwd: dir, llm: blocking, maxStepsPerRun: 10 })
    const run = live.request("do work")
    while (!blocking.started) await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await live.retry()).ok).toBe(false)
    live.pause()
    await run
    expect((await live.retry()).ok).toBe(false) // paused
  })
})
