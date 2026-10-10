import { describe, expect, test } from "bun:test"
import { completeInput } from "../src/tui/complete.ts"

const MODELS = ["deepseek-flash", "deepseek-chat", "gpt-4o-mini"]

describe("completeInput", () => {
  test("completes a unique command and adds a space", () => {
    const result = completeInput("/hel", 4, MODELS)
    expect(result?.text).toBe("/help ")
    expect(result?.cursor).toBe(6)
  })

  test("completes to the longest common prefix when ambiguous", () => {
    // /t -> /thinking, /thinking-blocks, /theme  => common prefix "/th"
    expect(completeInput("/t", 2, MODELS)?.text).toBe("/th")
  })

  test("completes model ids after /model", () => {
    const result = completeInput("/model deepseek-f", 17, MODELS)
    expect(result?.text).toBe("/model deepseek-flash ")
  })

  test("completes model ids to a shared prefix", () => {
    // deepseek-flash / deepseek-chat share "/model deepseek-"
    expect(completeInput("/model deeps", 12, MODELS)?.text).toBe("/model deepseek-")
  })

  test("ignores ordinary text", () => {
    expect(completeInput("please fix the bug", 18, MODELS)).toBeUndefined()
  })

  test("preserves text after the cursor", () => {
    const result = completeInput("/hel please", 4, MODELS)
    expect(result?.text).toBe("/help  please")
  })
})
