import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime } from "../src/agent/runtime.ts"
import {
  appendControlRecord,
  controlLogPathFor,
  formatControlRecord,
  pauseControl,
  readControlRecords,
  resumeControl,
} from "../src/agent/control.ts"
import { buildUserPrompt } from "../src/agent/prompt.ts"
import { createMetrics } from "../src/agent/metrics.ts"
import type { AgentState } from "../src/agent/types.ts"
import type { LLMClient, ModelInput, StreamHandlers } from "../src/llm/client.ts"
import type { ModelAction } from "../src/stack/schemas.ts"
import { statusChip } from "../src/tui/status.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-control-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** First model call blocks until aborted; later calls finish the turn. */
class PausableLLM implements LLMClient {
  readonly label = "pausable"
  calls = 0
  started = false
  sawAbort = false

  async step(_input: ModelInput, _handlers?: StreamHandlers, signal?: AbortSignal): Promise<ModelAction> {
    this.calls += 1
    this.started = true
    if (this.calls === 1) {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          this.sawAbort = true
          const error = new Error("The operation was aborted.")
          error.name = "AbortError"
          reject(error)
        }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    }
    return { tool: "user", input: { message: "done", response: "none" } }
  }
}

function makeRuntime(llm: LLMClient): AgentRuntime {
  return new AgentRuntime({ cwd: dir, llm, maxStepsPerRun: 20 })
}

describe("control log", () => {
  test("records round-trip through an append-only JSONL log", () => {
    const path = join(dir, "session.control.jsonl")
    appendControlRecord(path, pauseControl(1000))
    appendControlRecord(path, resumeControl(2000))
    appendControlRecord(path, {
      kind: "steer",
      id: "s1",
      at: 3000,
      text: "use the existing parser",
      scope: "round",
    })

    const records = readControlRecords(path)
    expect(records.map((record) => record.kind)).toEqual(["pause", "resume", "steer"])
    expect(records[2]).toMatchObject({ text: "use the existing parser", scope: "round" })
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3)
  })

  test("a torn tail line is skipped, not fatal", () => {
    const path = join(dir, "torn.control.jsonl")
    appendControlRecord(path, pauseControl(1000))
    writeFileSync(path, '{"kind":"res', { flag: "a" })
    expect(readControlRecords(path).map((record) => record.kind)).toEqual(["pause"])
  })

  test("the control log lives beside the session checkpoint", () => {
    expect(controlLogPathFor("/tmp/run.json")).toBe("/tmp/run.control.jsonl")
    expect(controlLogPathFor("/tmp/run")).toBe("/tmp/run.control.jsonl")
  })

  test("control records render as one human-readable line", () => {
    expect(formatControlRecord(pauseControl(0))).toContain("paused")
    expect(formatControlRecord(resumeControl(0))).toContain("resumed")
    expect(formatControlRecord({ kind: "retry", id: "r", at: 0, round: 3, note: "stuck" })).toContain("round 3")
    expect(formatControlRecord({ kind: "amend-goal", id: "g", at: 0, text: "narrow scope", revision: 2 })).toContain("revision 2")
  })
})

describe("pause and resume", () => {
  test("pause stops the in-flight turn, keeps state, and writes a control record", async () => {
    const llm = new PausableLLM()
    const runtime = makeRuntime(llm)
    const logPath = join(dir, "session.control.jsonl")
    runtime.attachControlLog(logPath)

    const run = runtime.request("do something")
    await waitFor(() => llm.started)
    expect(runtime.isRunning).toBe(true)
    expect(runtime.pause()).toBe(true)
    await run

    expect(llm.sawAbort).toBe(true)
    expect(runtime.isRunning).toBe(false)
    expect(runtime.isPaused).toBe(true)
    expect(runtime.snapshot().paused).toBe(true)

    const state = runtime.snapshot()
    expect(state.conversation.some((entry) => entry.source === "control" && entry.text.includes("paused"))).toBe(true)
    expect(state.conversation.some((entry) => entry.role === "note" && entry.text.includes("interrupted"))).toBe(false)
    expect(readControlRecords(logPath).map((record) => record.kind)).toEqual(["pause"])

    expect(runtime.pause()).toBe(false) // already paused
  })

  test("resume continues the same conversation and logs the resume", async () => {
    const llm = new PausableLLM()
    const runtime = makeRuntime(llm)
    const logPath = join(dir, "session.control.jsonl")
    runtime.attachControlLog(logPath)

    const run = runtime.request("do something")
    await waitFor(() => llm.started)
    runtime.pause()
    await run

    const resumed = await runtime.resume()
    expect(resumed).toBe(true)
    expect(runtime.isPaused).toBe(false)
    expect(runtime.isRunning).toBe(false)
    expect(runtime.snapshot().paused).toBeUndefined()
    expect(llm.calls).toBe(2) // the interrupted call was discarded, not replayed
    expect(readControlRecords(logPath).map((record) => record.kind)).toEqual(["pause", "resume"])
    expect(runtime.snapshot().conversation.some((entry) => entry.text.includes("resumed"))).toBe(true)
    expect(await runtime.resume()).toBe(false) // not paused any more
  })

  test("typing while paused resumes with that instruction", async () => {
    const llm = new PausableLLM()
    const runtime = makeRuntime(llm)
    const logPath = join(dir, "session.control.jsonl")
    runtime.attachControlLog(logPath)

    const run = runtime.request("do something")
    await waitFor(() => llm.started)
    runtime.pause()
    await run

    await runtime.request("try a different approach")
    expect(runtime.isPaused).toBe(false)
    const state = runtime.snapshot()
    expect(state.conversation.some((entry) => entry.role === "user" && entry.text === "try a different approach")).toBe(true)
    expect(readControlRecords(logPath).map((record) => record.kind)).toEqual(["pause", "resume"])
  })

  test("pause is a no-op while idle", () => {
    const runtime = makeRuntime(new PausableLLM())
    expect(runtime.pause()).toBe(false)
    expect(runtime.isPaused).toBe(false)
  })

  test("pause records never enter the model prompt", () => {
    const prompt = buildUserPrompt({
      mode: "execute",
      conversation: [
        { id: "1", at: 0, role: "user", text: "⏸ paused — discarded", tokens: 1, source: "control", modelVisible: false },
        { id: "2", at: 0, role: "user", text: "real request", tokens: 1 },
      ],
      stack: [],
      files: [],
      fileBudgetTokens: 100,
      fileUsedTokens: 0,
      observation: "",
      workingContext: "",
    })
    expect(prompt).toContain("real request")
    expect(prompt).not.toContain("⏸ paused")
  })
})

describe("paused status", () => {
  const state = (overrides: Partial<AgentState>): AgentState => ({
    mode: "execute",
    running: false,
    conversation: [],
    stack: [],
    closedFrames: [],
    files: [],
    metrics: createMetrics(),
    ...overrides,
  })

  test("the chip says PAUSED before any other idle phase", () => {
    expect(statusChip(state({ paused: true })).label).toBe("PAUSED")
    expect(statusChip(state({})).label).toBe("IDLE")
  })
})
