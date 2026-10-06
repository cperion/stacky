import { describe, expect, test } from "bun:test"
import { describeToolCall } from "../src/agent/format-action.ts"

describe("describeToolCall", () => {
  test("bash shows the command, never JSON", () => {
    expect(describeToolCall("bash", { command: "ls -la && echo '---'" })).toBe("ls -la && echo '---'")
  })

  test("read shows the path", () => {
    expect(describeToolCall("read", { path: "src/tui/theme.ts" })).toBe("src/tui/theme.ts")
  })

  test("edit summarises the number of edits", () => {
    expect(describeToolCall("edit", { path: "src/a.ts", edits: [{}, {}] })).toBe("src/a.ts  ·  2 edits")
    expect(describeToolCall("edit", { path: "src/a.ts", edits: [{}] })).toBe("src/a.ts  ·  1 edit")
  })

  test("push shows the first line of why", () => {
    expect(describeToolCall("push", { why: "because this\nand that" })).toBe("because this")
  })

  test("pop shows the outcome and reason", () => {
    expect(describeToolCall("pop", { outcome: "completed", whyClosed: "tests pass" })).toBe(
      "completed  ·  tests pass",
    )
  })

  test("never returns raw JSON for known tools", () => {
    for (const [tool, input] of [
      ["bash", { command: "true" }],
      ["read", { path: "a" }],
      ["push", { why: "w", scope: "s" }],
      ["pop", { outcome: "completed", whyClosed: "c" }],
    ] as const) {
      expect(describeToolCall(tool, input)).not.toContain("{")
    }
  })
})
