import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "../src/memory/store.ts"
import { WorkspaceMemory } from "../src/memory/views.ts"
import { AgentRuntime } from "../src/agent/runtime.ts"
import { ScriptedLLM } from "../src/llm/scripted.ts"

let directory: string
let cwd: string
let store: MemoryStore
let memory: WorkspaceMemory
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "stacky-instructions-"))
  cwd = join(directory, "project")
  mkdirSync(join(cwd, "src", "api", "deep"), { recursive: true })
  mkdirSync(join(cwd, "other"))
  writeFileSync(join(directory, "AGENTS.md"), "ANCESTOR_RULE")
  writeFileSync(join(cwd, "AGENTS.md"), "ROOT_RULE")
  writeFileSync(join(cwd, "src", "AGENTS.md"), "SOURCE_RULE")
  writeFileSync(join(cwd, "src", "api", "AGENTS.md"), "API_RULE")
  writeFileSync(join(cwd, "src", "api", "deep", "code.ts"), "const value = 1;\n")
  writeFileSync(join(cwd, "other", "AGENTS.md"), "OTHER_RULE")
  writeFileSync(join(cwd, "other", "code.ts"), "SIBLING_CODE")
  store = new MemoryStore(join(directory, "archive"))
  memory = new WorkspaceMemory({ cwd, store, budgetTokens: 1200 })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

test("startup pins ancestor/root rules; directory and deep-file reads discover only their chain", () => {
  let context = memory.materialize()
  expect(context).toContain("ANCESTOR_RULE")
  expect(context).toContain("ROOT_RULE")
  expect(context).not.toContain("SOURCE_RULE")
  expect(memory.read({ path: "src" }).ok).toBe(true)
  context = memory.materialize()
  expect(context).toContain("SOURCE_RULE")
  expect(context).not.toContain("API_RULE")
  expect(memory.read({ path: "src/api/deep/code.ts" }).ok).toBe(true)
  context = memory.materialize()
  expect(context).toContain("API_RULE")
  expect(context).toContain("scope src/api/ and descendants")
  expect(context).not.toContain("OTHER_RULE")
  expect(context.indexOf("ANCESTOR_RULE")).toBeLessThan(context.indexOf("ROOT_RULE"))
  expect(context.indexOf("ROOT_RULE")).toBeLessThan(context.indexOf("API_RULE"))
  memory.capture("log output ".repeat(2000), { title: "large log" })
  memory.setBudget(40)
  context = memory.materialize()
  expect(context).toContain("exceed the working-view budget")
  for (const rule of ["ANCESTOR_RULE", "ROOT_RULE", "SOURCE_RULE", "API_RULE"]) expect(context).toContain(rule)
  expect(context).not.toContain("large log")
})

test("discovered scopes survive eviction/restart and refresh complete rules without truncation", () => {
  memory.read({ path: "src/api/deep/code.ts" })
  memory.capture("log ".repeat(3000), { title: "output" })
  const selections = memory.exportViews()
  writeFileSync(join(cwd, "src", "api", "AGENTS.md"), "NEW_RULE\n".repeat(500) + "FINAL_RULE")
  const restored = new WorkspaceMemory({ cwd, store, budgetTokens: 1200 })
  restored.restoreViews(selections)
  const context = restored.materialize()
  expect(context).toContain("FINAL_RULE")
  expect(context).not.toContain("API_RULE")
  rmSync(join(cwd, "src", "api", "AGENTS.md"))
  expect(restored.materialize()).not.toContain("FINAL_RULE")
  restored.clear()
  expect(restored.materialize()).toContain("ROOT_RULE")
  expect(restored.materialize()).toContain("SOURCE_RULE")
})

test("new guidance blocks an in-flight edit until the model can review it", () => {
  memory.read({ path: "src/api/deep/code.ts" })
  writeFileSync(join(cwd, "src", "api", "deep", "AGENTS.md"), "NEW_DEEP_RULE")
  const input = { path: "src/api/deep/code.ts", edits: [{ oldText: "value = 1", newText: "value = 2" }] }
  const refused = memory.edit(input)
  expect(refused.ok).toBe(false)
  expect(refused.message).toContain("Review the pinned instructions")
  expect(readFileSync(join(cwd, "src", "api", "deep", "code.ts"), "utf8")).toContain("value = 1")
  expect(memory.materialize()).toContain("NEW_DEEP_RULE")
  expect(memory.edit(input).ok).toBe(true)
})

test("symlink traversal and delegation share scoped rules, not ordinary code views", () => {
  symlinkSync("src/api/deep", join(cwd, "alias"))
  memory.read({ path: "alias/code.ts" })
  expect(memory.materialize()).toContain("SOURCE_RULE")
  expect(memory.materialize()).toContain("API_RULE")
  const child = new WorkspaceMemory({ cwd, store })
  child.inheritInstructions(memory)
  expect(child.materialize()).toContain("API_RULE")
  expect(child.materialize()).not.toContain("const value")
  child.read({ path: "other/code.ts" })
  memory.inheritInstructions(child)
  expect(memory.materialize()).toContain("OTHER_RULE")
  expect(memory.materialize()).not.toContain("SIBLING_CODE")
})

test("the first actual model prompt already contains pinned repository instructions", async () => {
  let seen = false
  const runtime = new AgentRuntime({ cwd, memoryStore: store, llm: new ScriptedLLM([(input) => {
    expect(input.prompt).toContain("PINNED INSTRUCTIONS")
    expect(input.prompt).toContain("ROOT_RULE")
    expect(input.system).toContain("More specific nested guidance overrides")
    seen = true
    return { tool: "user", input: { message: "ready", response: "none" } }
  }]) })
  await runtime.request("Check guidance")
  expect(seen).toBe(true)
  runtime.dispose()
})
