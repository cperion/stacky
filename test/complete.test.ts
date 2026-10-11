import { describe, expect, test } from "bun:test"
import { applyCompletion, completionSet, completeInput, PromptHistory } from "../src/tui/complete.ts"

const MODELS = ["deepseek-flash", "deepseek-chat", "gpt-4o-mini"]

describe("completeInput", () => {
  test("completes a unique command and adds a space", () => {
    const result = completeInput("/hel", 4, MODELS)
    expect(result?.text).toBe("/help ")
    expect(result?.cursor).toBe(6)
  })

  test("completes to the longest common prefix when ambiguous", () => {
    expect(completeInput("/thi", 4, MODELS)?.text).toBe("/thinking")
  })

  test("completes model ids after /model", () => {
    const result = completeInput("/model deepseek-f", 17, MODELS)
    expect(result?.text).toBe("/model deepseek-flash ")
  })

  test("completes model ids to a shared prefix", () => {
    // deepseek-flash / deepseek-chat share "/model deepseek-"
    expect(completeInput("/model deeps", 12, MODELS)?.text).toBe("/model deepseek-")
  })

  test("replaces the entire token when completing in the middle", () => {
    expect(completeInput("/help next", 3, MODELS)).toEqual({ text: "/help next", cursor: 6 })
  })

  test("completes command arguments and aliases", () => {
    expect(completeInput("/theme d", 8, MODELS)?.text).toBe("/theme dark ")
    expect(completeInput("/think of", 9, MODELS)?.text).toBe("/think off ")
    expect(completeInput("/login ch", 9, MODELS)?.text).toBe("/login chatgpt ")
  })

  test("model substring matches keep the provider-qualified id", () => {
    const line = "/model sonnet"
    const set = completionSet(line, line.length, [{ value: "anthropic/claude-sonnet-4-5", description: "provider list" }])!
    expect(applyCompletion(line, set, set.candidates[0]!).text).toBe("/model anthropic/claude-sonnet-4-5 ")
  })

  test("ignores ordinary text", () => {
    expect(completeInput("please fix the bug", 18, MODELS)).toBeUndefined()
  })

  test("preserves text after the cursor", () => {
    const result = completeInput("/hel please", 4, MODELS)
    expect(result?.text).toBe("/help please")
    expect(result?.cursor).toBe(6)
  })
})

describe("PromptHistory", () => {
  test("walks both ways and restores the unfinished draft", () => {
    const history = new PromptHistory()
    history.add("first")
    history.add("second")
    expect(history.move(-1, "draft")).toBe("second")
    expect(history.move(-1, "second")).toBe("first")
    expect(history.move(1, "first")).toBe("second")
    expect(history.move(1, "second")).toBe("draft")
  })
  test("edits of recalled entries become a new draft", () => {
    const history = new PromptHistory()
    history.add("first")
    expect(history.move(-1, "")).toBe("first")
    expect(history.move(-1, "edited")).toBe("first")
    expect(history.move(1, "first")).toBe("edited")
  })
  test("ignores empty input and adjacent duplicates", () => {
    const history = new PromptHistory()
    history.add("")
    expect(history.move(-1, "")).toBeUndefined()
    history.add("a")
    history.add("a")
    expect(history.move(-1, "draft")).toBe("a")
    expect(history.move(1, "a")).toBe("draft")
  })
})
