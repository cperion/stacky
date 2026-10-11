import {
  bold,
  BoxRenderable,
  dim,
  fg,
  reverse,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import { theme, scrollbarOptions } from "./theme.ts"
import { clipText, concat, fit, header, plain, rule, sectionRule, type Part } from "./render.ts"

export type MenuItem =
  | { kind: "separator"; label?: string }
  | {
      kind: "action"
      label: string
      hint?: string
      checked?: boolean
      run: () => void | Promise<void>
      keepOpen?: boolean
    }
  | { kind: "toggle"; label: string; hint?: string; value: () => boolean; set: (v: boolean) => void | Promise<void> }
  | {
      kind: "choice"
      label: string
      hint?: string
      value: () => string
      options: () => string[]
      set: (v: string) => void | Promise<void>
    }
  | { kind: "submenu"; label: string; hint?: string; items: () => MenuItem[] | Promise<MenuItem[]> }

type Level = { title: string; items: MenuItem[]; selected?: number }

const LABEL_WIDTH = 22

/** A modal settings menu: a stack of levels rendered as a centered overlay. */
export class MenuOverlay {
  readonly box: BoxRenderable
  private text: TextRenderable
  private message: TextRenderable
  private scroll: ScrollBoxRenderable
  private stack: Level[] = []
  private index = 0
  private busy = false
  private error = ""
  private generation = 0
  private innerWidth = 40

  constructor(private renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, {
      position: "absolute",
      left: "20%",
      top: "14%",
      width: "62%",
      height: "70%",
      zIndex: 200,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.dim,
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      visible: false,
    })
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      scrollbarOptions: scrollbarOptions(),
    })
    this.text = new TextRenderable(renderer, { content: "", fg: theme.fg, bg: theme.bg, wrapMode: "word" })
    this.scroll.add(this.text)
    this.box.add(this.scroll)
    this.message = new TextRenderable(renderer, { content: "", fg: theme.fg, bg: theme.bg, wrapMode: "word", height: 2, flexShrink: 0 })
    this.box.add(this.message)
  }

  /** Centre the modal with pixel geometry (absolute percentages are unreliable). */
  relayout(): void {
    const width = this.renderer.terminalWidth
    const height = this.renderer.terminalHeight
    const boxWidth = Math.min(Math.max(1, width - 2), Math.min(96, Math.max(44, Math.floor(width * 0.78))))
    const boxHeight = Math.min(Math.max(1, height - 2), Math.max(10, Math.floor(height * 0.8)))
    this.innerWidth = Math.max(1, boxWidth - 6)
    this.box.width = boxWidth
    this.box.height = boxHeight
    this.box.left = Math.max(0, Math.floor((width - boxWidth) / 2))
    this.box.top = Math.max(0, Math.floor((height - boxHeight) / 2))
    if (this.box.visible) this.render()
  }

  private contentWidth(): number {
    // Layout getters still report the old geometry during the first open/resize.
    return this.innerWidth
  }

  get isOpen(): boolean {
    return this.box.visible
  }

  open(title: string, items: MenuItem[]): void {
    this.generation += 1
    this.busy = false
    this.error = ""
    this.stack = [{ title, items }]
    this.index = nextSelectable(items, -1, 1)
    this.relayout()
    this.box.visible = true
    this.render()
  }

  close(): void {
    this.generation += 1
    this.box.visible = false
    this.stack = []
  }

  move(delta: number): void {
    if (this.busy) return
    this.error = ""
    const level = this.current()
    if (!level) return
    const next = nextSelectable(level.items, this.index, delta)
    if (next >= 0) this.index = next
    this.render()
  }

  toTop(): void {
    if (this.busy) return
    const level = this.current()
    if (!level) return
    const first = nextSelectable(level.items, -1, 1)
    if (first >= 0) this.index = first
    this.render()
  }

  toBottom(): void {
    if (this.busy) return
    const level = this.current()
    if (!level) return
    const last = nextSelectable(level.items, 0, -1)
    if (last >= 0) this.index = last
    this.render()
  }

  back(): void {
    if (this.busy) return
    this.error = ""
    if (this.stack.length > 1) {
      this.stack.pop()
      this.index = this.current()!.selected ?? nextSelectable(this.current()!.items, -1, 1)
      this.render()
    } else {
      this.close()
    }
  }

  async activate(): Promise<void> {
    const level = this.current()
    const item = level?.items[this.index]
    if (!item || item.kind === "separator" || this.busy) return
    const generation = this.generation
    this.busy = true
    this.error = ""
    this.render()
    try {
      switch (item.kind) {
        case "action":
          await item.run()
          if (generation === this.generation && !item.keepOpen) this.close()
          return
        case "toggle":
          await item.set(!item.value())
          return
        case "choice": {
          const options = item.options()
          const at = options.indexOf(item.value())
          const next = options[(at + 1) % options.length] ?? options[0]
          if (next !== undefined) await item.set(next)
          return
        }
        case "submenu": {
          const items = await item.items()
          if (generation !== this.generation) return
          level!.selected = this.index
          this.stack.push({ title: item.label, items })
          this.index = nextSelectable(items, -1, 1)
          this.scroll.scrollTop = 0
          return
        }
      }
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (generation === this.generation) {
        this.busy = false
        if (this.isOpen) this.render()
      }
    }
  }

  private current(): Level | undefined {
    return this.stack[this.stack.length - 1]
  }

  private render(): void {
    if (this.renderer.isDestroyed) return
    const level = this.current()
    if (!level) return

    const width = this.contentWidth()
    const rowWidth = Math.max(1, width - 1)
    const parts: Part[] = [
      header(level.title, this.busy ? "loading…" : this.stack.length > 1 ? "‹ back" : "", width),
      plain("\n"),
      rule(rowWidth),
      plain("\n"),
    ]

    let row = 2
    let selectedRow = 2
    level.items.forEach((item, i) => {
      if (i > 0) row += 1
      if (i === this.index) selectedRow = row
      if (i > 0) parts.push(plain("\n"))
      if (item.kind === "separator") {
        row += 1
        parts.push(plain("\n"))
        parts.push(sectionRule(item.label ?? "", rowWidth))
        return
      }

      const selected = i === this.index
      const marker = selected ? "❯" : " "
      const label = `${item.label.padEnd(LABEL_WIDTH)}  `
      if (selected) {
        // Reverse video only renders correctly with an explicit default bg.
        parts.push(reverse(bold(fit(`${marker} ${label}${valueText(item)}`, rowWidth))))
      } else {
        const name = clipText(`${marker} ${label}`, rowWidth)
        parts.push(plain(name), dim(clipText(valueText(item), Math.max(0, rowWidth - name.length))))
      }
    })

    this.message.content = concat([this.error ? fg(theme.red)(this.error) : dim(this.busy ? "Esc close" : "j/k move · Enter select · h back · Esc close")])

    this.text.content = concat(parts)
    const visibleRows = Math.max(1, this.scroll.height - 3)
    if (selectedRow < this.scroll.scrollTop) this.scroll.scrollTop = selectedRow
    else if (selectedRow >= this.scroll.scrollTop + visibleRows) this.scroll.scrollTop = selectedRow - visibleRows + 1
  }
}

function valueText(item: Exclude<MenuItem, { kind: "separator" }>): string {
  switch (item.kind) {
    case "toggle":
      return item.value() ? "● on" : "○ off"
    case "choice":
      return item.value()
    case "submenu":
      return `›  ${item.hint ?? ""}`.trimEnd()
    case "action":
      return `${item.checked ? "✓ " : ""}${item.hint ?? ""}`.trimEnd()
  }
}

function nextSelectable(items: MenuItem[], from: number, delta: number): number {
  if (items.length === 0) return -1
  let i = from
  for (let step = 0; step < items.length; step++) {
    i = (i + delta + items.length) % items.length
    if (items[i]?.kind !== "separator") return i
  }
  return -1
}
