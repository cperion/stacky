/**
 * Human-readable descriptions of tool calls, so transcripts and prompts show
 * "edit src/a.ts · 2 edits" instead of raw JSON.
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

export function describeToolCall(tool: string, input: unknown): string {
  const args = asRecord(input)
  switch (tool) {
    case "bash":
      return firstLine(text(args.command) ?? "shell command")
    case "read":
      return text(args.path) ?? "file"
    case "edit": {
      const path = text(args.path) ?? "file"
      const edits = Array.isArray(args.edits) ? args.edits.length : 0
      return `${path}${edits > 0 ? `  ·  ${edits} edit${edits === 1 ? "" : "s"}` : ""}`
    }
    case "push":
      return firstLine(text(args.why) ?? "new task frame")
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
