import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { AgentRuntime } from "../src/agent/runtime.ts"
import { ScriptedLLM, type ScriptStep } from "../src/llm/scripted.ts"
import { MemoryStore } from "../src/memory/store.ts"
import { readSchema, editPatchSchema } from "../src/stack/schemas.ts"
import type { ModelAction } from "../src/stack/schemas.ts"

let dir: string
let runtimes: AgentRuntime[]
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "stacky-memory-runtime-")); runtimes = [] })
afterEach(() => { for (const runtime of runtimes) runtime.dispose(); rmSync(dir, { recursive: true, force: true }) })
const push = (title: string): ModelAction => ({ tool: "push", input: { title, why: title, scope: "fixture", knownContext: "", definitionOfDone: "verified", todos: [`${title} step`] } })
const done: ModelAction = { tool: "todo", input: { index: 1, status: "done" } }
const pop: ModelAction = { tool: "pop", input: { outcome: "completed", whatWasDone: "ran fixture", whyClosed: "verified", evidence: "recorded tool result", effectsOnParent: "resume parent verification" } }
const report: ModelAction = { tool: "user", input: { message: "verified", response: "none" } }
function runtime(steps: ScriptStep[], budget = 1200, conversationBudget = 500): AgentRuntime {
  const instance = new AgentRuntime({ cwd: dir, llm: new ScriptedLLM(steps), memoryDirectory: join(dir, `archive-${runtimes.length}`), fileBudgetTokens: budget, conversationBudgetTokens: conversationBudget })
  runtimes.push(instance)
  return instance
}
function succeeded(instance: AgentRuntime): void {
  expect(instance.lastReport).toBe("verified")
  expect(instance.snapshot().conversation.some((entry) => entry.text.includes("Runtime stopped:"))).toBe(false)
}
function anchor(prompt: string, text: string): string {
  const match = [...prompt.matchAll(/^\[([0-9a-f]+)\|\d+\] (.*)$/gm)].find((match) => match[2] === text)
  if (!match) throw new Error(`Missing visible anchor for ${text}`)
  return match[1]!
}

describe("unified memory through the real runtime", () => {
  test("current anchors edit once, refresh the view, and do not duplicate code in the transcript", async () => {
    writeFileSync(join(dir, "code.ts"), "const value = 1;\n")
    let edited = false
    const agent = runtime([
      push("Change value"),
      { tool: "read", input: { path: "code.ts" } },
      (input) => {
        expect(input.prompt).toContain("# WORKING CONTEXT")
        const ref = anchor(input.prompt, "const value = 1;")
        return { tool: "edit", input: { edits: [{ from: ref, through: ref, text: "const value = 2;" }] } }
      },
      (input) => {
        expect(input.prompt.match(/const value = 2;/g)).toHaveLength(1)
        expect(input.prompt).not.toContain("const value = 1;")
        edited = true
        return done
      }, pop, report,
    ])
    await agent.request("Change the value and verify the new view.")
    succeeded(agent)
    expect(edited).toBe(true)
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("const value = 2;\n")
    const store = new MemoryStore(agent.snapshot().memory!.directory)
    const calls = store.events({ type: "tool.call" })
    expect(calls.some((entry) => (entry.value.payload as ModelAction).tool === "edit")).toBe(true)
    store.close()
  })

  test("large command output is captured before paging and can be searched in the omitted middle", async () => {
    const output = `${"x".repeat(30_000)}ARCHIVE_NEEDLE${"y".repeat(30_000)}`
    writeFileSync(join(dir, "output.txt"), output)
    let artifactRef = ""
    let recovered = false
    const agent = runtime([
      push("Inspect output"),
      { tool: "bash", input: { command: "cat output.txt" } },
      (input) => {
        expect(input.prompt).toContain("exit 0")
        expect(input.prompt).not.toContain("ARCHIVE_NEEDLE")
        artifactRef = input.prompt.match(/Captured bash call [0-9a-f]+ · cat output\.txt as ([0-9a-f]+)/)?.[1] ?? ""
        if (!artifactRef) throw new Error("Missing artifact receipt")
        return { tool: "read", input: { ref: artifactRef, find: "ARCHIVE_NEEDLE" } }
      },
      (input) => {
        const hit = input.prompt.match(/Line 1: read\(\{ref:"([0-9a-f]+)"\}\)/)?.[1]
        if (!hit) throw new Error("Missing match cursor")
        return { tool: "read", input: { ref: hit, budgetTokens: 512 } }
      },
      (input) => { expect(input.prompt).toContain("ARCHIVE_NEEDLE"); recovered = true; return report },
    ])
    await agent.request("Inspect command output without rerunning it.")
    succeeded(agent)
    expect(recovered).toBe(true)
    expect(agent.metrics.toolCalls).toBe(5)
    expect(agent.snapshot().memory!.usedTokens).toBeLessThanOrEqual(1200)
    expect(agent.snapshot().files).toEqual([]) // logs never confer live file authority
    const store = new MemoryStore(agent.snapshot().memory!.directory)
    expect(store.loadText(artifactRef).text).toBe(output)
    expect(store.events({ type: "bash.result" })).toHaveLength(1)
    store.close()
  })

  test("closed child history survives FIFO and view eviction; own turns remain correctly nested", async () => {
    writeFileSync(join(dir, "large.txt"), "unrelated context\n".repeat(3000))
    writeFileSync(join(dir, "evidence.txt"), "EVIDENCE_FROM_CLOSED_CHILD")
    let recovered = false
    let childId = ""
    let rootId = ""
    let agent: AgentRuntime
    agent = runtime([
      push("Parent task"), push("Investigate child"),
      { tool: "bash", input: { command: "cat evidence.txt" } }, done, pop,
      { tool: "read", input: { path: "large.txt" } },
      (input) => {
        expect(input.prompt).not.toContain("EVIDENCE_FROM_CLOSED_CHILD")
        const state = agent.snapshot()
        const child = state.closedFrames[0]!.intent
        childId = child.id
        rootId = state.stack[0]!.id
        return { tool: "read", input: { ref: child.historyRef!, find: "bash.result" } }
      },
      (input) => {
        const ref = input.prompt.match(/"outputRef":"([0-9a-f]+)"/)?.[1]
        if (!ref) throw new Error("Missing linked evidence in historical result")
        return { tool: "read", input: { ref } }
      },
      (input) => { expect(input.prompt).toContain("EVIDENCE_FROM_CLOSED_CHILD"); recovered = true; return report },
    ], 1200, 80)
    await agent.request("Investigate with a nested frame and recover its evidence later.")
    succeeded(agent)
    expect(recovered).toBe(true)
    const store = new MemoryStore(agent.snapshot().memory!.directory)
    const owned = store.events({ frameId: childId, type: "tool.call" })
    expect(owned.some((entry) => (entry.value.payload as ModelAction).tool === "bash")).toBe(true)
    expect(store.events({ frameId: rootId, type: "bash.result" })).toHaveLength(0)
    expect(store.events({ frameId: rootId, type: "frame.resume" })).toHaveLength(1)
    expect(agent.snapshot().closedFrames[0]!.intent.parentId).toBe(rootId)
    store.close()
  })

  test("stale anchors refuse writes even if the changed region still looks similar", async () => {
    writeFileSync(join(dir, "a.txt"), "old\n")
    let refused = false
    const agent = runtime([
      push("Guard edit"), { tool: "read", input: { path: "a.txt" } },
      (input) => {
        const ref = anchor(input.prompt, "old")
        writeFileSync(join(dir, "a.txt"), "external\n")
        return { tool: "edit", input: { edits: [{ from: ref, through: ref, text: "unsafe" }] } }
      },
      (input) => { expect(input.prompt).toContain("stale"); refused = true; return report },
    ])
    await agent.request("Exercise the revision guard.")
    succeeded(agent)
    expect(refused).toBe(true)
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("external\n")
  })

  test("restart retains exact refs but loads live files from disk; another workspace cannot inherit them", async () => {
    writeFileSync(join(dir, "a.txt"), "old\n")
    const first = runtime([push("Persist"), { tool: "read", input: { path: "a.txt" } }, report])
    await first.request("Read and persist")
    const oldAnchor = anchor(first.inspectContext(), "old")
    const saved = first.exportSession()
    writeFileSync(join(dir, "a.txt"), "new\n")
    let historical = false
    const second = runtime([
      (input) => { expect(input.prompt).toContain("] new"); return { tool: "read", input: { ref: oldAnchor } } },
      (input) => {
        expect(input.prompt).toContain("READ-ONLY")
        expect(input.prompt).toContain("] old")
        historical = true
        return { tool: "edit", input: { edits: [{ from: oldAnchor, through: oldAnchor, text: "wrong" }] } }
      }, report,
    ])
    second.importSession(saved)
    await second.request("Inspect the old observation without editing it.")
    succeeded(second)
    expect(historical).toBe(true)
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new\n")
    const foreign = new AgentRuntime({ cwd: join(dir, "other"), llm: new ScriptedLLM([]), memoryDirectory: join(dir, "foreign-archive") })
    runtimes.push(foreign)
    expect(() => foreign.importSession(saved)).toThrow("Session belongs to")
  })

  test("interruption refuses a late action even when the model ignores cancellation", async () => {
    let ready!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { ready = resolve })
    const deferred = new Promise<void>((resolve) => { release = resolve })
    const agent = runtime([push("Interrupt safely"), async () => {
      ready()
      await deferred
      return { tool: "bash", input: { command: "touch MUST_NOT_EXIST" } }
    }])
    const run = agent.request("Stop before the late tool runs")
    await waiting
    agent.interrupt()
    release()
    await run
    expect(existsSync(join(dir, "MUST_NOT_EXIST"))).toBe(false)
    expect(agent.metrics.toolCalls).toBe(1)
  })

  test("transient reasoning is not copied into the archive or checkpoint", async () => {
    const agent = runtime([
      (_input, handlers) => { handlers?.onReasoningDelta?.("TRANSIENT_REASONING_MARKER"); return push("Observe") },
      report,
    ])
    await agent.request("Keep observable history")
    succeeded(agent)
    expect(JSON.stringify(agent.exportSession())).not.toContain("TRANSIENT_REASONING_MARKER")
    const store = new MemoryStore(agent.snapshot().memory!.directory)
    expect(store.events({ query: "TRANSIENT_REASONING_MARKER" })).toHaveLength(0)
    store.close()
  })

  test("reset archives explicit abandonment and does not mutate an exported checkpoint", async () => {
    const agent = runtime([push("Unfinished task"), report])
    await agent.request("Begin a responsibility")
    const checkpoint = agent.exportSession()
    const rootRef = agent.snapshot().memory!.historyRef
    agent.reset()
    expect(agent.snapshot().stack).toEqual([])
    expect(checkpoint.stack).toHaveLength(1)
    expect(checkpoint.stack[0]!.todos[0]!.status).toBe("pending")
    const store = new MemoryStore(agent.snapshot().memory!.directory)
    const closed = store.events({ type: "frame.close" })
    expect(closed).toHaveLength(1)
    expect(JSON.stringify(closed[0]!.value)).toContain("Explicit user reset")
    expect(JSON.stringify(closed[0]!.value)).toContain("abandoned")
    expect(agent.inspectHistory(rootRef)).toContain("Root frames")
    store.close()
  })

  test("tool schemas stay provider-compatible objects and reject ambiguous shapes", () => {
    expect(z.toJSONSchema(readSchema).type).toBe("object")
    expect(z.toJSONSchema(editPatchSchema).type).toBe("object")
    expect(readSchema.safeParse({ path: "a", ref: "abc" }).success).toBe(false)
    expect(readSchema.safeParse({ ref: "abc", find: "literal" }).success).toBe(true)
    expect(editPatchSchema.safeParse({ edits: [{ from: "abc", through: "def", text: "ok" }] }).success).toBe(true)
    expect(editPatchSchema.safeParse({ edits: [{ from: "abc", after: "def", text: "no" }] }).success).toBe(false)
    expect(editPatchSchema.safeParse({ path: "a", edits: [{ from: "abc", through: "def", text: "no" }] }).success).toBe(false)
  })
})
