import { describe, expect, test } from "bun:test"
import { renderMarkdown } from "../src/tui/markdown.ts"

function textOf(styled: ReturnType<typeof renderMarkdown>): string {
  return styled.chunks.map((chunk) => chunk.text).join("")
}

describe("renderMarkdown", () => {
  test("strips inline markers and keeps the text", () => {
    const styled = renderMarkdown("**bold** and `code` and *italic* and ~~gone~~", 80)
    expect(textOf(styled)).toBe("bold and code and italic and gone")
  })

  test("applies attributes and colours", () => {
    const styled = renderMarkdown("**bold** `code` [link](https://x.test)", 80)
    const bold = styled.chunks.find((chunk) => chunk.text === "bold")
    expect(bold?.attributes ?? 0).toBeGreaterThan(0)
    const code = styled.chunks.find((chunk) => chunk.text === "code")
    expect(code?.fg).toBeDefined()
    expect(textOf(styled)).toContain("link (https://x.test)")
  })

  test("renders headings, lists and fenced code with structure", () => {
    const styled = renderMarkdown("# Title\n\n- one\n- two\n\n```js\nconst x = 1\n```\n", 40)
    const text = textOf(styled)
    expect(text).toContain("Title")
    expect(text).toContain("• one")
    expect(text).toContain("• two")
    expect(text).toContain("▌ const x = 1")
    expect(text).not.toContain("#")
    expect(text).not.toContain("```")
  })

  test("wraps long lines to the width", () => {
    const styled = renderMarkdown("word ".repeat(40).trim(), 20)
    for (const line of textOf(styled).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(20)
    }
  })

  test("orders list markers", () => {
    const styled = renderMarkdown("1. first\n2. second", 40)
    expect(textOf(styled)).toContain("1. first")
    expect(textOf(styled)).toContain("2. second")
  })
})
