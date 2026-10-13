import { bold, dim, fg, type StyledText } from "@opentui/core"
import { theme } from "./theme.ts"
import { clipText, concat, plain, wrapRaw, type Part } from "./render.ts"

const MAX_DETAIL_LINES = 20

/**
 * Render a tool call. The first line is `→ tool  <summary>`; remaining lines are
 * a detail body — search/replace edits arrive as `- old` / `+ new` and render as
 * a diff (red removals, green additions).
 */
export function renderToolCall(entry: { text: string; tool?: string }, width: number, expanded = false, id?: string): StyledText {
  const tool = entry.tool ?? /^([a-z_]+)\(/.exec(entry.text)?.[1] ?? "tool"
  const detail = entry.tool ? entry.text : entry.text.replace(/^[a-z_]+\(/, "").replace(/\)$/, "")
  const [first = "", ...rest] = detail.split("\n")

  const prefix = "  → "
  const hanging = prefix.length + tool.length + 2
  const available = Math.max(8, width - hanging)

  const parts: Part[] = [
    concat([fg(theme.blue)(prefix), bold(fg(theme.blue)(tool)), plain("  "), plain(clipText(first, available))]),
  ]

  const rows = rest.flatMap((line) => wrapRaw(line, available).map((text) => ({ text, kind: line[0] })))
  for (const row of expanded ? rows : rows.slice(0, MAX_DETAIL_LINES)) {
    parts.push(plain(`\n${" ".repeat(hanging)}`))
    if (row.kind === "+") parts.push(fg(theme.green)(row.text))
    else if (row.kind === "-") parts.push(fg(theme.red)(row.text))
    else parts.push(plain(row.text))
  }

  if (rows.length > MAX_DETAIL_LINES) {
    parts.push(plain(`\n${" ".repeat(hanging)}`), dim(expanded
      ? `… (${rows.length} total lines, ctrl+o to compact)`
      : `… (${rows.length - MAX_DETAIL_LINES} more lines, ${rows.length} total, ctrl+o to expand${id ? ` · /expand ${id}` : ""})`))
  }

  return concat(parts)
}
