import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime } from "../src/agent/runtime.ts"
import { DemoLLM, ScriptedLLM, type ScriptStep } from "../src/llm/scripted.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-todo-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const POP: ScriptStep = {
  tool: "pop",
  input: { outcome: "completed", whatWasDone: "x", whyClosed: "y", evidence: "", effectsOnParent: "" },
}

function runtimeWith(steps: ScriptStep[]) {
  return new AgentRuntime({ cwd: dir, llm: new ScriptedLLM(steps), maxStepsPerRun: 40 })
}

describe("frame todos", () => {
  test("offline demo resolves its checklist before closing the survey", async () => {
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "package.json"), '{"name":"demo"}')
    const runtime = new AgentRuntime({ cwd: dir, llm: new DemoLLM() })
    await runtime.request("survey")
    expect(runtime.snapshot().mode).toBe("waiting_for_user")
    await runtime.request("Stop here")
    const snapshot = runtime.snapshot()
    expect(snapshot.stack).toHaveLength(0)
    expect(snapshot.closedFrames).toHaveLength(1)
    expect(snapshot.conversation.some((entry) => entry.role === "protocol")).toBe(false)
  })

  test("pop is refused while a todo is still pending", async () => {
    const runtime = runtimeWith([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["one", "two"] } },
      { tool: "todo", input: { index: 1, status: "done" } },
      POP, // refused: step two still pending
      { tool: "todo", input: { index: 2, status: "abandoned", note: "not needed" } },
      POP, // now allowed
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    const state = runtime.snapshot()
    expect(state.stack).toHaveLength(0)
    expect(state.closedFrames).toHaveLength(1)
    expect(state.conversation.some((entry) => entry.text.includes("pop REFUSED"))).toBe(true)
    expect(state.conversation.some((entry) => entry.text.includes("todo #1 done"))).toBe(true)
    expect(state.conversation.some((entry) => entry.text.includes("todo #2 abandoned"))).toBe(true)
  })

  test("abandoning a todo requires a note", async () => {
    const runtime = runtimeWith([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["one"] } },
      { tool: "todo", input: { index: 1, status: "abandoned" } },
      { tool: "todo", input: { index: 1, status: "done" } },
      POP,
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    const transcript = runtime.snapshot().conversation.map((entry) => entry.text).join("\n")
    expect(transcript).toContain("needs a note")
    expect(runtime.snapshot().stack).toHaveLength(0)
  })

  test("frames are created with the requested todos", async () => {
    const runtime = runtimeWith([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["a", "b", "c"] } },
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    const frame = runtime.snapshot().stack[0]
    expect(frame?.todos.map((todo) => todo.text)).toEqual(["a", "b", "c"])
    expect(frame?.todos.every((todo) => todo.status === "pending")).toBe(true)
  })
})
