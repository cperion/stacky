import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime } from "../src/agent/runtime.ts"
import { ScriptedLLM, type ScriptStep } from "../src/llm/scripted.ts"
import type { RuntimeEvent } from "../src/agent/events.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-runtime-"))
  writeFileSync(join(dir, "a.txt"), "hello world")
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function makeRuntime(steps: ScriptStep[], events?: RuntimeEvent[]) {
  const llm = new ScriptedLLM(steps)
  const runtime = new AgentRuntime({ cwd: dir, llm, maxStepsPerRun: 50 })
  if (events) runtime.bus.on((event) => events.push(event))
  return runtime
}

describe("AgentRuntime", () => {
  test("runs the full push -> read -> edit -> pop -> user(none) cycle", async () => {
    const events: RuntimeEvent[] = []
    const runtime = makeRuntime(
      [
        { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
        { tool: "read", input: { path: "a.txt" } },
        { tool: "edit", input: { path: "a.txt", edits: [{ oldText: "hello world", newText: "hello stacky" }] } },
        { tool: "bash", input: { command: "cat a.txt" } },
        { tool: "todo", input: { index: 1, status: "done" } },
        {
          tool: "pop",
          input: { outcome: "completed", whatWasDone: "edited", whyClosed: "done", evidence: "cat", effectsOnParent: "none" },
        },
        { tool: "user", input: { message: "All done.", response: "none" } },
      ],
      events,
    )

    await runtime.request("please update the greeting")

    const state = runtime.snapshot()
    expect(state.stack).toHaveLength(0)
    expect(state.closedFrames).toHaveLength(1)
    expect(state.closedFrames[0]?.disposition.outcome).toBe("completed")
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello stacky")
    expect(state.files.map((f) => f.path)).toContain("a.txt")
    expect(runtime.isRunning).toBe(false)
    expect(events.some((e) => e.type === "frame.pushed")).toBe(true)
    expect(events.some((e) => e.type === "frame.popped")).toBe(true)
    expect(events.some((e) => e.type === "file.promoted")).toBe(true)
  })

  test("user(required) suspends the loop and resumes the same frame", async () => {
    const runtime = makeRuntime([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "read", input: { path: "a.txt" } },
      {
        tool: "user",
        input: {
          message: "Which way?",
          response: "required",
          choices: [
            { id: "x", label: "X" },
            { id: "y", label: "Y" },
          ],
          preferredChoice: { id: "y", reason: "better" },
        },
      },
      { tool: "bash", input: { command: "echo resumed" } },
      { tool: "todo", input: { index: 1, status: "done" } },
      { tool: "pop", input: { outcome: "completed", whatWasDone: "did it", whyClosed: "done", evidence: "", effectsOnParent: "" } },
      { tool: "user", input: { message: "Done.", response: "none" } },
    ])

    await runtime.request("go")
    expect(runtime.isWaitingForUser).toBe(true)
    expect(runtime.snapshot().userRequest?.response).toBe("required")
    expect(runtime.snapshot().stack).toHaveLength(1)

    const observed: RuntimeEvent[] = []
    runtime.bus.on((event) => observed.push(event))
    await runtime.request("y")
    expect(runtime.isWaitingForUser).toBe(false)
    expect(runtime.snapshot().userRequest).toBeUndefined()
    expect(runtime.snapshot().stack).toHaveLength(0)
    expect(observed.some((e) => e.type === "user.resolved")).toBe(true)
  })

  test("rejects edit in push mode and recovers", async () => {
    const events: RuntimeEvent[] = []
    const runtime = makeRuntime(
      [
        { tool: "edit", input: { path: "a.txt", edits: [{ oldText: "hello world", newText: "nope" }] } },
        { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
        { tool: "user", input: { message: "Yielded with an active frame.", response: "none" } },
      ],
      events,
    )

    await runtime.request("do something")
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello world")
    expect(events.some((e) => e.type === "protocol.error")).toBe(true)
    expect(runtime.snapshot().stack).toHaveLength(1)
  })

  test("rejects pop on an empty stack", async () => {
    const events: RuntimeEvent[] = []
    const runtime = makeRuntime(
      [
        { tool: "todo", input: { index: 1, status: "done" } },
        {
          tool: "pop",
          input: { outcome: "completed", whatWasDone: "x", whyClosed: "y", evidence: "", effectsOnParent: "" },
        },
        { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
        { tool: "user", input: { message: "ok", response: "none" } },
      ],
      events,
    )
    await runtime.request("go")
    expect(events.some((e) => e.type === "protocol.error")).toBe(true)
  })

  test("edit refuses ambiguous matches", async () => {
    writeFileSync(join(dir, "dup.txt"), "x\nx\n")
    const runtime = makeRuntime([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "read", input: { path: "dup.txt" } },
      { tool: "edit", input: { path: "dup.txt", edits: [{ oldText: "x", newText: "y" }] } },
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    expect(readFileSync(join(dir, "dup.txt"), "utf8")).toBe("x\nx\n")
  })

  test("refuses to edit an existing file that was not read first", async () => {
    const events: RuntimeEvent[] = []
    const runtime = makeRuntime(
      [
        { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
        { tool: "edit", input: { path: "a.txt", edits: [{ oldText: "hello world", newText: "nope" }] } },
        { tool: "read", input: { path: "a.txt" } },
        { tool: "edit", input: { path: "a.txt", edits: [{ oldText: "hello world", newText: "hello!" }] } },
        { tool: "user", input: { message: "done", response: "none" } },
      ],
      events,
    )
    await runtime.request("go")
    // First edit was refused; the retry after read() succeeded.
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello!")
    const observations = runtime.snapshot().conversation.filter((e) => e.role === "observation")
    expect(observations.some((o) => o.text.includes("not in your working set"))).toBe(true)
  })

  test("creates a new file when oldText is empty", async () => {
    const runtime = makeRuntime([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "edit", input: { path: "new/dir/file.txt", edits: [{ oldText: "", newText: "created" }] } },
      { tool: "user", input: { message: "done", response: "none" } },
    ])
    await runtime.request("go")
    expect(readFileSync(join(dir, "new/dir/file.txt"), "utf8")).toBe("created")
  })
})
