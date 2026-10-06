import { describe, expect, test } from "bun:test"
import { renderToolCall } from "../src/tui/action.ts"
import { theme } from "../src/tui/theme.ts"

function textOf(styled: ReturnType<typeof renderToolCall>): string {
  return styled.chunks.map((chunk) => chunk.text).join("")
}

describe("renderToolCall", () => {
  test("renders the tool name and a single-line summary", () => {
    const styled = renderToolCall({ tool: "bash", text: "ls -la" }, 80)
    expect(textOf(styled)).toBe("  → bash  ls -la")
  })

  test("renders edit diffs with removals and additions", () => {
    const styled = renderToolCall({ tool: "edit", text: "src/a.ts\n- const x = 1\n+ const x = 2" }, 80)
    const text = textOf(styled)
    expect(text).toContain("→ edit")
    expect(text).toContain("- const x = 1")
    expect(text).toContain("+ const x = 2")

    const removed = styled.chunks.find((chunk) => chunk.text.includes("- const x = 1"))
    const added = styled.chunks.find((chunk) => chunk.text.includes("+ const x = 2"))
    expect(removed?.fg?.equals(theme.red)).toBe(true)
    expect(added?.fg?.equals(theme.green)).toBe(true)
  })

  test("clips long lines to the width", () => {
    const styled = renderToolCall({ tool: "bash", text: "x".repeat(200) }, 40)
    for (const line of textOf(styled).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40)
    }
  })
})
