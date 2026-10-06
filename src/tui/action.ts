import { bold, dim, fg, type StyledText } from "@opentui/core"
import { theme } from "./theme.ts"
import { clipText, concat, plain, type Part } from "./render.ts"

const MAX_DETAIL_LINES = 24

/**
 * Render a tool call. The first line is `→ tool  <summary>`; remaining lines are
 * a detail body — search/replace edits arrive as `- old` / `+ new` and render as
 * a diff (red removals, green additions).
 */
export function renderToolCall(entry: { text: string; tool?: string }, width: number): StyledText {
  const tool = entry.tool ?? /^([a-z_]+)\(/.exec(entry.text)?.[1] ?? "tool"
  const detail = entry.tool ? entry.text : entry.text.replace(/^[a-z_]+\(/, "").replace(/\)$/, "")
  const [first = "", ...rest] = detail.split("\n")

  const prefix = "  → "
  const hanging = prefix.length + tool.length + 2
  const available = Math.max(8, width - hanging)

  const parts: Part[] = [
    concat([fg(theme.blue)(prefix), bold(fg(theme.blue)(tool)), plain("  "), plain(clipText(first, available))]),
  ]

  for (const line of rest.slice(0, MAX_DETAIL_LINES)) {
    parts.push(plain(`\n${" ".repeat(hanging)}`))
    const clipped = clipText(line, available)
    if (line.startsWith("+")) parts.push(fg(theme.green)(clipped))
    else if (line.startsWith("-")) parts.push(fg(theme.red)(clipped))
    else parts.push(dim(clipped))
  }

  if (rest.length > MAX_DETAIL_LINES) {
    parts.push(plain(`\n${" ".repeat(hanging)}`), dim(`… ${rest.length - MAX_DETAIL_LINES} more lines`))
  }

  return concat(parts)
}
