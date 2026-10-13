import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { OutputBlocks, OutputViewer, outputPreview } from "../src/tui/output.ts"
import { createMetrics } from "../src/agent/metrics.ts"
import type { AgentState } from "../src/agent/types.ts"
import { Composer } from "../src/tui/composer.ts"

function state(): AgentState {
  return { mode: "push", running: false, conversation: [], stack: [], closedFrames: [], files: [], metrics: createMetrics() }
}

test("thinking previews wrap into multiple bounded rows, including single-paragraph streams", () => {
  const preview = outputPreview("a useful thought ".repeat(100), 48, 4, true)
  expect(preview.split("\n")).toHaveLength(5)
  expect(preview).toContain("│ …")
  expect(preview.split("\n").every((line) => line.length <= 48)).toBe(true)
})

test("expansion resolves full captured output without replacing the compact receipt", () => {
  const snapshot = state()
  snapshot.conversation = [
    { id: "thought", at: 0, role: "thinking", text: "plan ".repeat(400), tokens: 500 },
    { id: "output", at: 1, role: "observation", text: "command finished (exit 0)", outputRef: "abc", tokens: 8 },
  ]
  const blocks = new OutputBlocks((ref) => { expect(ref).toBe("abc"); return "HEAD\n" + "x".repeat(30_000) + "\nTAIL" })
  blocks.sync(snapshot)
  const compact = blocks.compact(snapshot.conversation[1]!, 70)
  expect(compact).toContain("/expand #2")
  expect(compact).not.toContain("TAIL")
  expect(blocks.text(blocks.select("#2"))).toContain("TAIL")
  expect(blocks.select("thinking").id).toBe("#1")
  blocks.sync(snapshot)
  expect(blocks.select("tools").id).toBe("#2")
  expect(snapshot.conversation[1]!.text).toBe("command finished (exit 0)")
})

test("viewer expands, pages, navigates blocks, and compacts without losing the input draft", async () => {
  const setup = await createTestRenderer({ width: 72, height: 22, kittyKeyboard: true })
  const composer = new Composer(setup.renderer, { provider: () => "deepseek", onSubmit() {} })
  const blocks = new OutputBlocks()
  const snapshot = state()
  snapshot.conversation = [
    { id: "thought", role: "thinking", text: "BEGIN\n" + "x".repeat(12_000) + "\nLAST PAGE", at: 0, tokens: 3000 },
    { id: "output", role: "observation", text: "test results", at: 0, tokens: 3 },
  ]
  blocks.sync(snapshot)
  const viewer = new OutputViewer(setup.renderer, blocks, (open) => open ? composer.input.blur() : composer.input.focus())
  setup.renderer.root.add(composer.box)
  setup.renderer.root.add(viewer.box)
  setup.renderer.keyInput.on("keypress", (key) => viewer.handleKey(key))
  try {
    composer.setText("unfinished draft")
    viewer.open("thinking")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("BEGIN")
    expect(setup.captureCharFrame()).toContain("page 1/2")
    await setup.mockInput.typeText("n")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("LAST PAGE")
    await setup.mockInput.typeText("l")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("test results")
    setup.mockInput.pressEscape()
    expect(viewer.isOpen).toBe(false)
    expect(composer.input.plainText).toBe("unfinished draft")
  } finally { composer.dispose(); setup.renderer.destroy() }
})
