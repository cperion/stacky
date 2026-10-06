/**
 * Human-readable descriptions of tool calls, so transcripts and prompts show
 * "edit src/a.ts" with a diff instead of raw JSON.
 */

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? ""
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

type EditOperation = { oldText?: unknown; newText?: unknown }

function diffText(path: string, edits: EditOperation[]): string {
  const lines = [edits.length > 1 ? `${path}  ·  ${edits.length} edits` : path]
  for (const edit of edits) {
    const oldText = text(edit.oldText) ?? ""
    const newText = text(edit.newText) ?? ""
    if (oldText) for (const line of oldText.split("\n")) lines.push(`- ${line}`)
    if (newText) for (const line of newText.split("\n")) lines.push(`+ ${line}`)
  }
  return lines.join("\n")
}

export function describeToolCall(tool: string, input: unknown): string {
  const args = asRecord(input)
  switch (tool) {
    case "bash":
      return firstLine(text(args.command) ?? "shell command")
    case "read":
      return text(args.path) ?? "file"
    case "edit": {
      const path = text(args.path) ?? "file"
      const edits = Array.isArray(args.edits) ? (args.edits as EditOperation[]) : []
      return diffText(path, edits)
    }
    case "todo": {
      const index = typeof args.index === "number" ? args.index : "?"
      const status = text(args.status) ?? "done"
      const note = text(args.note)
      return `#${index} ${status}${note ? ` · ${note}` : ""}`
    }
    case "push":
      return firstLine(text(args.title) ?? text(args.why) ?? "new task frame")
    case "spawn":
      return firstLine(text(args.title) ?? text(args.why) ?? "sub-task")
    case "pop": {
      const outcome = text(args.outcome) ?? "closed"
      const why = firstLine(text(args.whyClosed) ?? "")
      return why ? `${outcome}  ·  ${why}` : outcome
    }
    case "user":
      return firstLine(text(args.message) ?? "message")
    default:
      return tool
  }
}
