import type { AgentState, ConversationEntry } from "../agent/types.ts"
import { wrapRaw } from "./render.ts"

type OutputKind = "thinking" | "output"
type OutputRecord = { id: string; key: string; kind: OutputKind; title: string; text: string; ref?: string }
export const COMPACT_OUTPUT_LINES = 20

function kindOf(entry: ConversationEntry): OutputKind | undefined {
  const role = entry.role === "subagent" ? entry.subrole : entry.role
  return role === "thinking" ? "thinking" : role === "observation" || (role === "action" && entry.text.includes("\n")) ? "output" : undefined
}

/** Limit visual rows after wrapping; expanded blocks have no display line cap. */
export function outputPreview(text: string, width: number, rows = COMPACT_OUTPUT_LINES, tail = false): string {
  const lines = wrapRaw(text, Math.max(4, width - 2))
  const selected = tail ? lines.slice(-rows) : lines.slice(0, rows)
  const more = lines.length > rows
  return [...(more && tail ? ["│ …"] : []), ...selected.map((line) => `│ ${line}`), ...(more && !tail ? ["│ …"] : [])].join("\n")
}

/** Inline UI state only: expansion never changes model attention or archives reasoning. */
export class OutputBlocks {
  private records = new Map<string, OutputRecord>()
  private expanded = new Set<string>()
  private sources = new Map<string, string>()
  private serial = 0
  private showThinking = true
  private live?: OutputRecord
  revision = 0
  constructor(private readOutput?: (ref: string) => string) {}

  sync(state: AgentState, showThinking = true): void {
    this.showThinking = showThinking
    for (const entry of state.conversation.filter((item) => kindOf(item)).slice(-64)) {
      const previous = this.records.get(entry.id)
      if (previous?.text === entry.text && previous.ref === entry.outputRef) continue
      const kind = kindOf(entry)!
      this.records.set(entry.id, { key: entry.id, id: previous?.id ?? `#${++this.serial}`, kind,
        title: `${entry.role === "subagent" ? "Subagent " : ""}${kind === "thinking" ? "Thinking" : entry.tool ?? "Tool output"}`,
        text: entry.text, ref: entry.outputRef })
      if (!previous && this.live?.kind === kind && this.expanded.has(this.live.key)) {
        this.expanded.add(entry.id)
        this.expanded.delete(this.live.key)
      }
      while (this.records.size > 64) {
        const key = this.records.keys().next().value!
        const ref = this.records.get(key)?.ref
        this.records.delete(key)
        this.expanded.delete(key)
        if (ref && ![...this.records.values()].some((record) => record.ref === ref)) this.sources.delete(ref)
      }
    }
    this.live = undefined
    if (state.activeTool === "bash" && state.toolOutput) {
      this.live = { key: "live:output", id: "live", kind: "output", title: "Live tool output", text: state.toolOutput }
    } else if (showThinking && state.streaming?.active && state.streaming.reasoning) {
      this.live = { key: `live:${state.streaming.startedAt}`, id: "live", kind: "thinking", title: "Thinking · live", text: state.streaming.reasoning }
    }
  }

  items(): OutputRecord[] {
    return [...this.records.values(), ...(this.live ? [this.live] : [])].filter((item) => this.showThinking || item.kind !== "thinking")
  }

  isExpanded(entry: ConversationEntry): boolean { return this.expanded.has(entry.id) }
  label(entry: ConversationEntry): string | undefined { return this.records.get(entry.id)?.id }

  render(entry: ConversationEntry, width: number): string {
    const record = this.records.get(entry.id) ?? { key: entry.id, id: "", kind: kindOf(entry) ?? "output", title: kindOf(entry) === "thinking" ? "Thinking" : "Tool output", text: entry.text, ref: entry.outputRef }
    return this.renderRecord(record, width)
  }

  renderLive(width: number): string { return this.live ? this.renderRecord(this.live, width, true) : "" }

  private renderRecord(record: OutputRecord, width: number, live = false): string {
    const expanded = this.expanded.has(record.key)
    const text = this.text(record)
    if (!record.ref && record.kind === "output" && !text.includes("\n")) return `│ ${text}`
    const lines = wrapRaw(text, Math.max(4, width - 2))
    const body = (expanded ? lines : lines.slice(0, COMPACT_OUTPUT_LINES)).map((line) => ` ${line}`).join("\n")
    const hidden = Math.max(0, lines.length - COMPACT_OUTPUT_LINES)
    const footer = expanded ? `\n … (${lines.length} total lines, ctrl+o to compact)`
      : hidden ? `\n … (${hidden} more lines, ${lines.length} total, ctrl+o to expand${live ? "" : ` · /expand ${record.id}`})` : ""
    return `${record.kind === "thinking" ? "✻" : "→"} ${record.title}\n\n${body}${footer}`
  }

  select(query = ""): OutputRecord {
    const items = this.items()
    const eligible = (item: OutputRecord) => item.ref || item.text.split("\n").length > COMPACT_OUTPUT_LINES || item.text.length > 1200 || this.expanded.has(item.key)
    const selected = query === "thinking" || query === "tools"
      ? items.findLast((item) => item.kind === (query === "tools" ? "output" : "thinking") && eligible(item))
        ?? items.findLast((item) => item.kind === (query === "tools" ? "output" : "thinking"))
      : query ? items.find((item) => item.id === query) : this.live ?? items.findLast(eligible) ?? items.at(-1)
    if (selected) return selected
    throw new Error("No matching output block. Use /expand, /expand thinking, or /expand #<number>.")
  }

  setExpanded(query = "", expanded = true): void {
    const record = this.select(query)
    if (expanded) this.expanded.add(record.key); else this.expanded.delete(record.key)
    this.revision++
  }
  toggle(query = ""): void {
    const record = this.select(query)
    this.setExpanded(query, !this.expanded.has(record.key))
  }
  compactAll(): void { this.expanded.clear(); this.revision++ }

  text(record: OutputRecord): string {
    if (!record.ref || !this.readOutput) return record.text
    let source = this.sources.get(record.ref)
    if (source === undefined) {
      try { source = this.readOutput(record.ref) }
      catch (error) { source = `[Output unavailable: ${error instanceof Error ? error.message : String(error)}]` }
      this.sources.set(record.ref, source)
    }
    return `${record.text}\n\n${source}`
  }
}
