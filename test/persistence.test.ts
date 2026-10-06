import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime } from "../src/agent/runtime.ts"
import { loadSession, saveSession } from "../src/agent/persistence.ts"
import { ScriptedLLM, type ScriptStep } from "../src/llm/scripted.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-session-"))
  writeFileSync(join(dir, "a.txt"), "hello")
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function runtimeWith(steps: ScriptStep[]) {
  return new AgentRuntime({ cwd: dir, llm: new ScriptedLLM(steps), maxStepsPerRun: 50 })
}

describe("session persistence", () => {
  test("saves paths, stack, history and metrics — never file contents", async () => {
    const runtime = runtimeWith([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "read", input: { path: "a.txt" } },
      { tool: "user", input: { message: "Explain?", response: "required" } },
    ])
    await runtime.request("go")
    expect(runtime.isWaitingForUser).toBe(true)

    const sessionPath = join(dir, ".stacky", "session.json")
    saveSession(runtime, sessionPath)
    const raw = readFileSync(sessionPath, "utf8")
    expect(raw).toContain("a.txt")
    expect(raw).not.toContain("hello")

    const restored = runtimeWith([])
    expect(loadSession(restored, sessionPath)).toBe(true)
    const state = restored.snapshot()
    expect(state.stack).toHaveLength(1)
    expect(state.mode).toBe("waiting_for_user")
    expect(state.files.map((f) => f.path)).toEqual(["a.txt"])
    expect(state.userRequest?.message).toBe("Explain?")
    expect(state.metrics.pushes).toBe(1)
  })

  test("restores an empty stack as push mode", async () => {
    const runtime = runtimeWith([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "todo", input: { index: 1, status: "done" } },
      { tool: "pop", input: { outcome: "completed", whatWasDone: "x", whyClosed: "y", evidence: "", effectsOnParent: "" } },
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    const sessionPath = join(dir, "session.json")
    saveSession(runtime, sessionPath)

    const restored = runtimeWith([])
    loadSession(restored, sessionPath)
    expect(restored.snapshot().mode).toBe("push")
    expect(restored.snapshot().closedFrames).toHaveLength(1)
  })

  test("re-materializes contents from disk instead of resurrecting stale state", () => {
    const runtime = runtimeWith([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "read", input: { path: "a.txt" } },
      { tool: "user", input: { message: "x", response: "none" } },
    ])
    return runtime.request("go").then(() => {
      const sessionPath = join(dir, "session.json")
      saveSession(runtime, sessionPath)
      writeFileSync(join(dir, "a.txt"), "updated after save")

      const restored = runtimeWith([])
      loadSession(restored, sessionPath)
      const internal = restored as unknown as { files: { materialize: () => { content: string }[] } }
      expect(internal.files.materialize()[0]?.content).toBe("updated after save")
    })
  })
})

describe("metrics", () => {
  test("counts frames, tools, files and outcomes", async () => {
    const runtime = runtimeWith([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "read", input: { path: "a.txt" } },
      { tool: "todo", input: { index: 1, status: "done" } },
      { tool: "pop", input: { outcome: "disproven", whatWasDone: "x", whyClosed: "y", evidence: "", effectsOnParent: "" } },
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    const m = runtime.metrics
    expect(m.pushes).toBe(1)
    expect(m.pops).toBe(1)
    expect(m.maxStackDepth).toBe(1)
    expect(m.filesPromoted).toBe(1)
    expect(m.outcomes.disproven).toBe(1)
    expect(m.toolCalls).toBe(5)
    expect(m.llmCalls).toBe(5)
  })
})
