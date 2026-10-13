import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core"
import type { AgentState, ConversationEntry } from "../agent/types.ts"
import { block, clipText, wrapRaw } from "./render.ts"
import { scrollbarOptions, theme } from "./theme.ts"

type OutputKind = "thinking" | "output"
type OutputRecord = { id: string; key: string; kind: OutputKind; title: string; text: string; ref?: string; preview: string }
const PAGE_CHARS = 12_000

function kindOf(entry: ConversationEntry): OutputKind | undefined {
  const role = entry.role === "subagent" ? entry.subrole : entry.role
  return role === "thinking" ? "thinking" : role === "observation" ? "output" : undefined
}

/** Bound visual rows AFTER wrapping, rather than truncating only explicit newlines. */
export function outputPreview(text: string, width: number, rows = 6, tail = false): string {
  const lines = wrapRaw(text, Math.max(4, width - 2))
  const selected = tail ? lines.slice(-rows) : lines.slice(0, rows)
  const more = lines.length > rows
  return [...(more && tail ? ["│ …"] : []), ...selected.map((line) => `│ ${line}`), ...(more && !tail ? ["│ …"] : [])].join("\n")
}

/** UI-only block registry. It never changes model views or archives reasoning. */
export class OutputBlocks {
  private records = new Map<string, OutputRecord>()
  private serial = 0
  private showThinking = true
  private live?: OutputRecord
  constructor(private readOutput?: (ref: string) => string) {}

  sync(state: AgentState, showThinking = true): void {
    this.showThinking = showThinking
    for (const entry of state.conversation.filter((item) => kindOf(item)).slice(-64)) {
      const previous = this.records.get(entry.id)
      if (previous?.text === entry.text && previous.ref === entry.outputRef) continue
      const kind = kindOf(entry)!
      let preview = entry.text
      if (entry.outputRef && this.readOutput) {
        try { preview += `\n${this.readOutput(entry.outputRef).slice(0, 2400)}` }
        catch (error) { preview += `\n[Output unavailable: ${error instanceof Error ? error.message : String(error)}]` }
      }
      this.records.set(entry.id, { key: entry.id, id: previous?.id ?? `#${++this.serial}`, kind,
        title: `${entry.role === "subagent" ? "Subagent " : ""}${kind === "thinking" ? "Thinking" : "Tool output"}`,
        text: entry.text, ref: entry.outputRef, preview })
      while (this.records.size > 64) this.records.delete(this.records.keys().next().value!)
    }
    this.live = undefined
    if (state.activeTool === "bash" && state.toolOutput) {
      this.live = { key: "live:output", id: "live", kind: "output", title: "Live tool output · recent stream; full capture available after completion", text: state.toolOutput, preview: state.toolOutput }
    } else if (showThinking && state.streaming?.active && state.streaming.reasoning) {
      this.live = { key: `live:${state.streaming.startedAt}`, id: "live", kind: "thinking", title: "Thinking · live", text: state.streaming.reasoning, preview: state.streaming.reasoning }
    }
  }

  items(): OutputRecord[] {
    return [...this.records.values(), ...(this.live ? [this.live] : [])].filter((item) => this.showThinking || item.kind !== "thinking")
  }

  compact(entry: ConversationEntry, width: number): string {
    const record = this.records.get(entry.id)
    const label = record?.title ?? (kindOf(entry) === "thinking" ? "Thinking" : "Tool output")
    const target = record?.id ?? entry.outputRef
    return `${kindOf(entry) === "thinking" ? "✻" : "→"} ${label}${target ? ` · /expand ${target}` : ""}\n${outputPreview(record?.preview ?? entry.text, width)}`
  }

  select(query = ""): OutputRecord {
    const items = this.items()
    const selected = query === "thinking" || query === "tools"
      ? items.findLast((item) => item.kind === (query === "tools" ? "output" : "thinking"))
      : query ? items.find((item) => item.id === query) : items.at(-1)
    if (selected) return selected
    if (query && !["thinking", "tools"].includes(query) && this.readOutput) {
      const text = this.readOutput(query)
      return { id: query, key: `archive:${query}`, kind: "output", title: `Archived output ${query}`, text, preview: text }
    }
    throw new Error("No matching output block. Use /expand, /expand thinking, or /expand <#number/ref>.")
  }

  text(record: OutputRecord): string {
    return record.ref && this.readOutput ? `${record.text}\n\n[Full captured source snapshot · read-only]\n${this.readOutput(record.ref)}` : record.text
  }
}

/** Scrollable expansion shared by panes and native-scrollback REPL. */
export class OutputViewer {
  readonly box: BoxRenderable
  private title: TextRenderable
  private text: TextRenderable
  private scroll: ScrollBoxRenderable
  private selected?: OutputRecord
  private source = ""
  private page = 0
  private signature = ""
  private lastSource = ""

  constructor(private renderer: CliRenderer, private blocks: OutputBlocks, private onToggle: (open: boolean) => void) {
    this.box = new BoxRenderable(renderer, { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", zIndex: 300,
      backgroundColor: theme.bg, border: true, borderColor: theme.dim, flexDirection: "column", paddingLeft: 1, paddingRight: 1, visible: false })
    this.title = new TextRenderable(renderer, { content: "", fg: theme.fg, height: 2, flexShrink: 0, wrapMode: "word" })
    this.scroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, scrollY: true, scrollX: false, scrollbarOptions: scrollbarOptions() })
    this.text = new TextRenderable(renderer, { content: "", fg: theme.fg, wrapMode: "none" })
    this.scroll.add(this.text)
    this.box.add(this.title)
    this.box.add(this.scroll)
    this.box.add(new TextRenderable(renderer, { content: "j/k/PgUp/PgDn scroll · n/p pages · h/l blocks · Ctrl+O compact", fg: theme.dim, height: 2, flexShrink: 0, wrapMode: "word" }))
  }

  get isOpen(): boolean { return this.box.visible }
  open(query = ""): void {
    this.choose(this.blocks.select(query))
    this.box.visible = true
    this.onToggle(true)
    this.refresh()
  }
  close(): void {
    this.box.visible = false
    this.selected = undefined
    this.source = ""
    this.lastSource = ""
    this.signature = ""
    this.text.content = ""
    this.onToggle(false)
  }
  toggle(): void { if (this.isOpen) this.close(); else this.open() }

  private choose(record: OutputRecord): void {
    try { this.source = this.blocks.text(record) }
    catch (error) { this.source = `Output unavailable: ${error instanceof Error ? error.message : String(error)}` }
    this.selected = record
    this.page = 0
    this.scroll.scrollTop = 0
  }

  refresh(): void {
    if (!this.isOpen || !this.selected) return
    if (this.selected.key.startsWith("live:")) {
      const latest = this.blocks.items().find((item) => item.key === this.selected!.key)
        ?? this.blocks.items().findLast((item) => item.kind === this.selected!.kind)
      if (latest) {
        this.selected = latest
        try { this.source = this.blocks.text(latest) }
        catch (error) { this.source = `Output unavailable: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const width = Math.max(4, this.renderer.width - 4)
    const pages = Math.max(1, Math.ceil(this.source.length / PAGE_CHARS))
    this.page = Math.min(this.page, pages - 1)
    const signature = `${this.selected.key}:${width}:${this.page}`
    if (signature === this.signature && this.source === this.lastSource) return
    this.signature = signature
    this.lastSource = this.source
    this.title.content = `${this.selected.title} · ${this.selected.id} · page ${this.page + 1}/${pages}${this.selected.kind === "output" ? `\n${clipText(this.selected.text.split("\n")[0] ?? "", width)}` : ""}`
    let start = this.page * PAGE_CHARS
    let end = Math.min(this.source.length, start + PAGE_CHARS)
    if (isLowSurrogate(this.source.charCodeAt(start))) start--
    if (end < this.source.length && isLowSurrogate(this.source.charCodeAt(end))) end--
    this.text.content = block(this.source.slice(start, end) || "(empty output)", width)
  }

  handleKey(key: KeyEvent): boolean {
    if (!this.isOpen) return false
    if (key.ctrl && key.name === "c") return false
    key.preventDefault()
    key.stopPropagation()
    if (key.name === "escape" || (key.ctrl && key.name === "o")) this.close()
    else if (key.name === "j" || key.name === "down") this.scroll.scrollBy(1)
    else if (key.name === "k" || key.name === "up") this.scroll.scrollBy(-1)
    else if (key.name === "pageup" || key.name === "pagedown") this.scroll.scrollBy((key.name === "pagedown" ? 1 : -1) * Math.max(1, this.scroll.viewport.height - 1))
    else if (key.name === "home") this.scroll.scrollTop = 0
    else if (key.name === "end") this.scroll.scrollTop = this.scroll.scrollHeight
    else if (key.name === "n" || key.name === "p") {
      this.page = Math.max(0, Math.min(Math.ceil(this.source.length / PAGE_CHARS) - 1, this.page + (key.name === "n" ? 1 : -1)))
      this.scroll.scrollTop = 0
      this.refresh()
    } else if (["h", "l", "left", "right"].includes(key.name)) {
      const items = this.blocks.items()
      const current = items.findIndex((item) => item.key === this.selected?.key)
      const next = items[Math.max(0, Math.min(items.length - 1, current + (["l", "right"].includes(key.name) ? 1 : -1)))]
      if (next) { this.choose(next); this.refresh() }
    }
    return true
  }
}

function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff }
