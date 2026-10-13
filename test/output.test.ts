import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { OutputBlocks, outputPreview, COMPACT_OUTPUT_LINES } from "../src/tui/output.ts"
import { createMetrics } from "../src/agent/metrics.ts"
import type { AgentState } from "../src/agent/types.ts"
import { ChatPane } from "../src/tui/chat-pane.ts"
import { renderToolCall } from "../src/tui/action.ts"

function state(): AgentState {
  return { mode: "push", running: false, conversation: [], stack: [], closedFrames: [], files: [], metrics: createMetrics() }
}

test("thinking previews wrap into multiple bounded rows, including single-paragraph streams", () => {
  const preview = outputPreview("a useful thought ".repeat(100), 48, 4, true)
  expect(preview.split("\n")).toHaveLength(5)
  expect(preview).toContain("│ …")
  expect(preview.split("\n").every((line) => line.length <= 48)).toBe(true)
})

test("20-line compact blocks expand inline without a second cap or changing model receipts", () => {
  const snapshot = state()
  const entry = { id: "output", at: 1, role: "observation" as const, text: "command finished (exit 0)", outputRef: "abc", tokens: 8 }
  snapshot.conversation = [entry]
  const blocks = new OutputBlocks(() => Array.from({ length: 82 }, (_, index) => `line ${index + 1}`).join("\n"))
  blocks.sync(snapshot)
  const compact = blocks.render(entry, 100)
  expect(COMPACT_OUTPUT_LINES).toBe(20)
  expect(compact).toContain("line 18")
  expect(compact).not.toContain("line 82")
  expect(compact).toContain("64 more lines, 84 total, ctrl+o to expand")
  blocks.setExpanded("#1")
  expect(blocks.render(entry, 100)).toContain("line 82")
  expect(entry.text).toBe("command finished (exit 0)")
  blocks.toggle()
  expect(blocks.render(entry, 100)).not.toContain("line 82")
})

test("tool-call details use the same 20-line limit and uncapped expansion", () => {
  const entry = { tool: "edit", text: "src/file.ts\n" + Array.from({ length: 82 }, (_, index) => `+ code ${index + 1}`).join("\n") }
  const text = (expanded: boolean) => renderToolCall(entry, 100, expanded, "#3").chunks.map((chunk) => chunk.text).join("")
  expect(text(false)).toContain("62 more lines, 82 total, ctrl+o to expand")
  expect(text(false)).not.toContain("code 82")
  expect(text(true)).toContain("code 82")
})

test("panes expand the existing thinking block inline, retaining its composer and render tree", async () => {
  const setup = await createTestRenderer({ width: 100, height: 50, kittyKeyboard: true })
  const outputs = new OutputBlocks()
  const chat = new ChatPane(setup.renderer, { outputs, provider: () => "deepseek", onSubmit() {} })
  setup.renderer.root.add(chat.box)
  try {
    await setup.renderOnce()
    chat.composer.setText("unfinished draft")
    const snapshot = state()
    snapshot.conversation = [{ id: "thought", role: "thinking", text: Array.from({ length: 30 }, (_, index) => `THOUGHT ${index + 1}`).join("\n"), at: 0, tokens: 100 }]
    chat.update(snapshot, 0, true)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("THOUGHT 30")
    const children = setup.renderer.root.getChildren().length
    outputs.toggle()
    chat.update(snapshot, 0, true)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("THOUGHT 30")
    expect(setup.renderer.root.getChildren()).toHaveLength(children)
    expect(chat.input.plainText).toBe("unfinished draft")
    outputs.compactAll()
    chat.update(snapshot, 0, true)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("THOUGHT 30")
  } finally { chat.composer.dispose(); setup.renderer.destroy() }
})
