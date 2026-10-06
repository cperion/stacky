import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime } from "../src/agent/runtime.ts"
import { ScriptedLLM, type ScriptStep } from "../src/llm/scripted.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-subagent-"))
  writeFileSync(join(dir, "a.txt"), "hello")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function runtimeWith(steps: ScriptStep[], maxDepth = 2) {
  return new AgentRuntime({ cwd: dir, llm: new ScriptedLLM(steps), maxStepsPerRun: 40, maxDepth })
}

describe("subagents", () => {
  test("spawn runs an isolated child and returns its report", async () => {
    const runtime = runtimeWith([
      // parent
      { tool: "push", input: { why: "root task", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "spawn", input: { why: "child sub-task", scope: "investigate a.txt", knownContext: "", definitionOfDone: "report", todos: ["step one"] } },
      // child (its own stack starts on the spawned frame)
      { tool: "read", input: { path: "a.txt" } },
      { tool: "user", input: { message: "child report: a.txt says hello", response: "none" } },
      // parent resumes
      { tool: "todo", input: { index: 1, status: "done" } },
      { tool: "pop", input: { outcome: "completed", whatWasDone: "delegated", whyClosed: "done", evidence: "", effectsOnParent: "" } },
      { tool: "user", input: { message: "all done", response: "none" } },
    ])

    await runtime.request("go")
    const state = runtime.snapshot()

    expect(state.metrics.subagents).toBe(1)
    const subagent = state.conversation.filter((entry) => entry.role === "subagent")
    expect(subagent.length).toBeGreaterThan(0)
    expect(subagent.every((entry) => entry.depth === 1)).toBe(true)

    const observation = state.conversation.find(
      (entry) => entry.role === "observation" && entry.text.includes("subagent report"),
    )
    expect(observation?.text).toContain("child report: a.txt says hello")
  })

  test("subagents cannot ask the user", async () => {
    const runtime = runtimeWith([
      { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      { tool: "spawn", input: { why: "child", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
      // child tries to ask the user (invalid) then reports
      { tool: "user", input: { message: "which one?", response: "required" } },
      { tool: "user", input: { message: "child report", response: "none" } },
      { tool: "todo", input: { index: 1, status: "done" } },
      { tool: "pop", input: { outcome: "completed", whatWasDone: "x", whyClosed: "y", evidence: "", effectsOnParent: "" } },
      { tool: "user", input: { message: "done", response: "none" } },
    ])

    await runtime.request("go")
    // The parent never entered the waiting-for-user state on behalf of the child.
    expect(runtime.snapshot().mode).not.toBe("waiting_for_user")
  })

  test("respects the nesting limit", async () => {
    const runtime = runtimeWith(
      [
        { tool: "push", input: { why: "root", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
        { tool: "spawn", input: { why: "level 1", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
        // child (depth 1) tries to spawn again, which is refused at maxDepth 1
        { tool: "spawn", input: { why: "level 2", scope: "s", knownContext: "", definitionOfDone: "d", todos: ["step one"] } },
        { tool: "user", input: { message: "child report", response: "none" } },
        { tool: "todo", input: { index: 1, status: "done" } },
        { tool: "pop", input: { outcome: "completed", whatWasDone: "x", whyClosed: "y", evidence: "", effectsOnParent: "" } },
        { tool: "user", input: { message: "done", response: "none" } },
      ],
      1,
    )

    await runtime.request("go")
    const state = runtime.snapshot()
    expect(state.metrics.subagents).toBe(1)
    // Only one subagent ran; the deeper spawn was refused (visible in the forwarded transcript).
    const transcript = state.conversation.map((entry) => entry.text).join("\n")
    expect(transcript).toContain("nesting limit")
  })
})
