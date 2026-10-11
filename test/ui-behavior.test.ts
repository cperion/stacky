import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { TaskStack } from "../src/stack/stack.ts"
import { createMetrics } from "../src/agent/metrics.ts"
import type { AgentState } from "../src/agent/types.ts"
import { AgentRuntime, formatUserMessage } from "../src/agent/runtime.ts"
import { DemoLLM } from "../src/llm/scripted.ts"
import { defaultConfig } from "../src/config.ts"
import { runCommand, type CommandContext } from "../src/tui/commands.ts"
import { changeModel, type SettingsController } from "../src/tui/settings.ts"
import { buildDashboard } from "../src/tui/repl.ts"
import { renderStatusLine } from "../src/tui/status.ts"
import { MenuOverlay } from "../src/tui/menu.ts"
import { ChatPane } from "../src/tui/chat-pane.ts"

function state(): AgentState {
  return { mode: "push", running: false, conversation: [], stack: [], closedFrames: [], files: [], metrics: createMetrics() }
}
function settings(): SettingsController {
  return {
    config: defaultConfig(), configPath: "/unused", isMock: true,
    runtime: new AgentRuntime({ cwd: process.cwd(), llm: new DemoLLM() }),
    rebuildModel() {}, persist() {},
  }
}

describe("model and command interaction", () => {
  test("failed model changes restore the old selection", () => {
    const ctx = settings()
    const before = { ...ctx.config }
    ctx.persist = () => { throw new Error("disk full") }
    expect(() => changeModel(ctx, { provider: "openai", model: "gpt-5" })).toThrow("disk full")
    expect(ctx.config).toEqual(before)
  })
  test("busy model switching doesn't mutate settings", () => {
    const ctx = settings()
    Object.defineProperty(ctx.runtime, "isRunning", { value: true })
    const before = { ...ctx.config }
    expect(() => changeModel(ctx, { provider: "openai", model: "gpt-5" })).toThrow("Esc")
    expect(ctx.config).toEqual(before)
  })
  test("async slash-command errors are shown, not unhandled rejections", async () => {
    const ctx = settings()
    ctx.rebuildModel = () => { throw new Error("bad transport") }
    const output: string[] = []
    const context: CommandContext = { settings: ctx, runtime: ctx.runtime, print: (text) => { output.push(text) }, switchUi() {}, quit() {} }
    runCommand("/model openai/test", context)
    await Promise.resolve()
    expect(output.join("\n")).toContain("Could not /model: bad transport")
  })
  test("model ids containing a slash are not truncated", () => {
    const ctx = settings()
    const context: CommandContext = { settings: ctx, runtime: ctx.runtime, print() {}, switchUi() {}, quit() {} }
    runCommand("/model openai/org/model", context)
    expect(ctx.config.model).toBe("org/model")
  })
  test("an unfinished model search cannot become a bogus active model", async () => {
    const ctx = settings()
    const output: string[] = []
    const context: CommandContext = { settings: ctx, runtime: ctx.runtime, print: (text) => { output.push(text) }, switchUi() {}, quit() {} }
    const before = ctx.config.model
    runCommand("/model refrsh", context)
    await Promise.resolve()
    expect(ctx.config.model).toBe(before)
    expect(output[0]).toContain("Tab to choose")
  })

  test("invalid boolean arguments do not silently disable settings", () => {
    const ctx = settings()
    const output: string[] = []
    const context: CommandContext = { settings: ctx, runtime: ctx.runtime, print: (text) => { output.push(text) }, switchUi() {}, quit() {} }
    runCommand("/dashboard maybe", context)
    expect(ctx.config.replDashboard).toBe(true)
    expect(output[0]).toContain("Usage:")
  })
})

describe("bounded layout", () => {
  test("the idle dashboard is silent and /dashboard off hides the whole panel", () => {
    const snapshot = state()
    const stack = new TaskStack()
    stack.push({ title: "Test", why: "why", scope: "scope", knownContext: "", definitionOfDone: "done", todos: ["first", "second", "third", "fourth"] })
    expect(buildDashboard(snapshot, 40, true, 24000).chunks.map((chunk) => chunk.text).join("")).toBe("")
    const busy = { ...snapshot, stack: [...stack.list()] }
    expect(buildDashboard(busy, 40, false, 24000).chunks.map((chunk) => chunk.text).join("")).toBe("")
    const text = buildDashboard(busy, 40, true, 24000, 3).chunks.map((chunk) => chunk.text).join("")
    expect(text.split("\n").length).toBe(3)
    expect(text).toContain("/task")
    expect(text.split("\n").every((line) => line.length <= 40)).toBe(true)
  })
  test("status lines fit small windows, including long model ids", () => {
    for (const width of [20, 40, 80, 120]) {
      const text = renderStatusLine(state(), "openai/" + "long".repeat(30), width).chunks.map((chunk) => chunk.text).join("")
      expect(text.length).toBeLessThanOrEqual(width)
    }
  })
  test("menus fit narrow terminals, report async errors, and keep the selection open", async () => {
    const setup = await createTestRenderer({ width: 40, height: 16 })
    try {
      const menu = new MenuOverlay(setup.renderer)
      setup.renderer.root.add(menu.box)
      menu.open("Models", [{ kind: "action", label: "Select", run: async () => { throw new Error("Sign in first") } }])
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("Select")
      expect(menu.box.width).toBeLessThanOrEqual(38)
      expect(menu.box.height).toBeLessThanOrEqual(14)
      await menu.activate()
      await setup.renderOnce()
      expect(menu.isOpen).toBe(true)
      expect(setup.captureCharFrame()).toContain("Sign in first")
    } finally { setup.renderer.destroy() }
  })
  test("closing an async submenu prevents its late result from reopening it", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const menu = new MenuOverlay(setup.renderer)
      setup.renderer.root.add(menu.box)
      let resolve!: (items: []) => void
      menu.open("Models", [{ kind: "submenu", label: "Provider", items: () => new Promise<[]>((done) => { resolve = done }) }])
      const pending = menu.activate()
      menu.close()
      resolve([])
      await pending
      expect(menu.isOpen).toBe(false)
    } finally { setup.renderer.destroy() }
  })
  test("active choices have one visual home and remain in answered history", async () => {
    const setup = await createTestRenderer({ width: 80, height: 36 })
    const chat = new ChatPane(setup.renderer, { provider: () => "deepseek", onSubmit() {} })
    try {
      setup.renderer.root.add(chat.box)
      await setup.renderOnce()
      const snapshot = state()
      snapshot.mode = "waiting_for_user"
      snapshot.userRequest = { id: "question", at: 0, message: "Which action?", response: "required", resolved: false, choices: [{ id: "a", label: "Run tests" }, { id: "b", label: "Stop here" }] }
      snapshot.conversation.push({ id: "1", at: 0, tokens: 20, role: "agent", text: formatUserMessage(snapshot.userRequest) })
      chat.update(snapshot, 0, false)
      await setup.renderOnce()
      expect(setup.captureCharFrame().split("Run tests").length - 1).toBe(1)
      snapshot.mode = "push"
      delete snapshot.userRequest
      chat.update(snapshot, 0, false)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("Run tests")
      expect(setup.captureCharFrame()).not.toContain("Needs your input")
    } finally { chat.composer.dispose(); setup.renderer.destroy() }
  })

  test("panes share the multiline prompt and the user gutter", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    let chat: ChatPane | undefined
    try {
      chat = new ChatPane(setup.renderer, { provider: () => "deepseek", onSubmit() {} })
      setup.renderer.root.add(chat.box)
      await setup.renderOnce()
      const snapshot = state()
      snapshot.conversation.push({ id: "1", at: 0, tokens: 5, role: "user", text: "Hello from the user" })
      chat.update(snapshot, 0, true)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("▌ Hello from the user")
      chat.update(snapshot, 0, true)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("▌ Hello from the user")
      expect(chat.input.height).toBe(3)
    } finally { chat?.composer.dispose(); setup.renderer.destroy() }
  })
})
