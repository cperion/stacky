import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Composer } from "../src/tui/composer.ts"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearModelCache } from "../src/llm/models.ts"

let setup: TestRendererSetup | undefined
let composer: Composer | undefined
async function create(width = 80, height = 24, splitFooter = false, canSubmit?: (text: string) => boolean) {
  setup = await createTestRenderer({ width, height, kittyKeyboard: true, ...(splitFooter ? { screenMode: "split-footer", footerHeight: 8 } : {}) })
  const sent: string[] = []
  composer = new Composer(setup.renderer, { provider: () => "deepseek", onSubmit: (text) => { sent.push(text) }, ...(canSubmit ? { canSubmit } : {}) })
  setup.renderer.root.add(composer.box)
  setup.renderer.keyInput.on("keypress", (key) => composer!.handleKey(key))
  composer.input.focus()
  await setup.renderOnce()
  return { ...setup, composer, sent }
}
afterEach(() => {
  composer?.dispose()
  setup?.renderer.destroy()
})

describe("shared composer keyboard", () => {
  test("shows candidates as you type; Tab cycles and Enter accepts without sending", async () => {
    const { mockInput, composer, sent, renderOnce, captureCharFrame } = await create()
    await mockInput.typeText("/th")
    await renderOnce()
    expect(captureCharFrame()).toContain("/theme")
    mockInput.pressTab()
    mockInput.pressEnter()
    expect(composer.input.plainText).toBe("/thinking ")
    expect(sent).toEqual([])
    mockInput.pressEnter()
    expect(sent).toEqual(["/thinking "])
  })

  test("Shift+Tab cycles backward, Escape dismisses without destroying the draft", async () => {
    const { mockInput, composer, renderOnce, captureCharFrame } = await create()
    await mockInput.typeText("/th")
    mockInput.pressTab({ shift: true })
    mockInput.pressEnter()
    expect(composer.input.plainText).toBe("/theme ")
    composer.setText("/th")
    mockInput.pressTab()
    mockInput.pressEscape()
    await renderOnce()
    expect(composer.input.plainText).toBe("/th")
    expect(captureCharFrame()).not.toContain("matches")
  })

  test("unique Tab completes and doesn't leave an extra tab in the buffer", async () => {
    const { mockInput, composer } = await create()
    await mockInput.typeText("/hel")
    mockInput.pressTab()
    expect(composer.input.plainText).toBe("/help ")
  })

  test("Shift+Enter and bracketed paste preserve multiline text; Enter submits", async () => {
    const { mockInput, composer, sent } = await create()
    await mockInput.typeText("first")
    mockInput.pressEnter({ shift: true })
    await mockInput.typeText("second")
    expect(composer.input.plainText).toBe("first\nsecond")
    mockInput.pressEnter()
    expect(sent).toEqual(["first\nsecond"])
    await mockInput.pasteBracketedText("one\ntwo")
    expect(composer.input.plainText).toBe("one\ntwo")
    expect(sent.length).toBe(1)
  })

  test("history traverses multiple entries and restores the draft with Alt arrows", async () => {
    const { mockInput, composer } = await create()
    await mockInput.typeText("first")
    mockInput.pressEnter()
    await mockInput.typeText("second")
    mockInput.pressEnter()
    await mockInput.typeText("draft")
    mockInput.pressArrow("up", { meta: true })
    expect(composer.input.plainText).toBe("second")
    mockInput.pressArrow("up", { meta: true })
    expect(composer.input.plainText).toBe("first")
    mockInput.pressArrow("down", { meta: true })
    expect(composer.input.plainText).toBe("second")
    mockInput.pressArrow("down", { meta: true })
    expect(composer.input.plainText).toBe("draft")
  })

  test("long input wraps inside the three-row editor", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await create(40)
    await mockInput.typeText("a short first line that wraps into a second line")
    await renderOnce()
    const frame = captureCharFrame().split("\n")
    expect(frame[0]).toContain("a short first line")
    expect(frame[1]).toContain("second line")
  })

  test("split-footer sizing uses the terminal, not the footer viewport", async () => {
    const { mockInput, composer, renderOnce } = await create(80, 24, true)
    await mockInput.typeText("/th")
    await renderOnce()
    expect(composer.height).toBe(7)
    expect(composer.input.height).toBe(3)
  })

  test("command palette restores the draft on Escape and after running a command", async () => {
    const { mockInput, composer, sent } = await create()
    await mockInput.typeText("unfinished draft")
    composer.openCommands()
    expect(composer.input.plainText).toBe("/")
    mockInput.pressEscape()
    expect(composer.input.plainText).toBe("unfinished draft")
    composer.openCommands()
    await mockInput.typeText("hel")
    mockInput.pressTab()
    mockInput.pressEnter()
    expect(sent).toEqual(["/help "])
    expect(composer.input.plainText).toBe("unfinished draft")
  })

  test("busy submission keeps the draft and explains why it wasn't sent", async () => {
    const { mockInput, composer, sent, renderOnce, captureCharFrame } = await create(80, 24, false, () => false)
    await mockInput.typeText("don't lose this")
    mockInput.pressEnter()
    await renderOnce()
    expect(sent).toEqual([])
    expect(composer.input.plainText).toBe("don't lose this")
    expect(captureCharFrame()).toContain("Draft kept")
  })

  test("background discovery preserves the highlighted model by id, not position", async () => {
    const keys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "STACKY_AUTH", "STACKY_MODELS"]
    const previous = keys.map((key) => process.env[key])
    const originalFetch = globalThis.fetch
    const dir = mkdtempSync(join(tmpdir(), "stacky-completion-"))
    try {
      clearModelCache()
      process.env.OPENAI_API_KEY = "test"
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.DEEPSEEK_API_KEY
      process.env.STACKY_AUTH = join(dir, "no-auth.json")
      process.env.STACKY_MODELS = join(dir, "models.json")
      writeFileSync(process.env.STACKY_MODELS, JSON.stringify({ openai: { ids: ["b", "a"], at: 0 } }))
      let resolve!: (value: Response) => void
      globalThis.fetch = (() => new Promise<Response>((done) => { resolve = done })) as unknown as typeof fetch
      const { mockInput, composer, sent } = await create()
      await mockInput.typeText("/model openai/")
      mockInput.pressTab() // b, the first cached candidate
      resolve(new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] })))
      await new Promise((done) => setTimeout(done, 10))
      mockInput.pressEnter()
      expect(composer.input.plainText).toBe("/model openai/b ")
      expect(sent).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      })
      clearModelCache()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("popup is bounded in a short terminal", async () => {
    const { mockInput, composer, renderOnce } = await create(40, 10)
    await mockInput.typeText("/")
    await renderOnce()
    expect(composer.height).toBeLessThanOrEqual(4)
  })
})
