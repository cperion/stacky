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
import { concat, fit, header, plain, rule, sectionRule, type Part } from "./render.ts"

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
  | { kind: "submenu"; label: string; hint?: string; items: () => MenuItem[] }

type Level = { title: string; items: MenuItem[] }

const LABEL_WIDTH = 22

/** A modal settings menu: a stack of levels rendered as a centered overlay. */
export class MenuOverlay {
  readonly box: BoxRenderable
  private text: TextRenderable
  private scroll: ScrollBoxRenderable
  private stack: Level[] = []
  private index = 0

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
      borderColor: theme.blue,
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
  }

  /** Centre the modal with pixel geometry (absolute percentages are unreliable). */
  relayout(): void {
    const width = this.renderer.terminalWidth
    const height = this.renderer.terminalHeight
    const boxWidth = Math.max(44, Math.floor(width * 0.62))
    const boxHeight = Math.max(10, Math.min(height - 2, Math.floor(height * 0.72)))
    this.box.width = boxWidth
    this.box.height = boxHeight
    this.box.left = Math.max(0, Math.floor((width - boxWidth) / 2))
    this.box.top = Math.max(0, Math.floor((height - boxHeight) / 2))
    if (this.box.visible) this.render()
  }

  private contentWidth(): number {
    return Math.max(24, Math.floor(this.renderer.terminalWidth * 0.62) - 6)
  }

  get isOpen(): boolean {
    return this.box.visible
  }

  open(title: string, items: MenuItem[]): void {
    this.stack = [{ title, items }]
    this.index = nextSelectable(items, -1, 1)
    this.relayout()
    this.box.visible = true
    this.render()
  }

  close(): void {
    this.box.visible = false
    this.stack = []
  }

  move(delta: number): void {
    const level = this.current()
    if (!level) return
    const next = nextSelectable(level.items, this.index, delta)
    if (next >= 0) this.index = next
    this.render()
  }

  toTop(): void {
    const level = this.current()
    if (!level) return
    const first = nextSelectable(level.items, -1, 1)
    if (first >= 0) this.index = first
    this.render()
  }

  toBottom(): void {
    const level = this.current()
    if (!level) return
    const last = nextSelectable(level.items, 0, -1)
    if (last >= 0) this.index = last
    this.render()
  }

  back(): void {
    if (this.stack.length > 1) {
      this.stack.pop()
      this.index = nextSelectable(this.current()!.items, -1, 1)
      this.render()
    } else {
      this.close()
    }
  }

  async activate(): Promise<void> {
    const level = this.current()
    const item = level?.items[this.index]
    if (!item || item.kind === "separator") return

    switch (item.kind) {
      case "action":
        await item.run()
        if (!item.keepOpen) this.close()
        else this.render()
        return
      case "toggle":
        await item.set(!item.value())
        this.render()
        return
      case "choice": {
        const options = item.options()
        const current = item.value()
        const at = options.indexOf(current)
        const next = options[(at + 1) % options.length] ?? options[0]
        if (next !== undefined) await item.set(next)
        this.render()
        return
      }
      case "submenu":
        this.stack.push({ title: item.label, items: item.items() })
        this.index = nextSelectable(this.current()!.items, -1, 1)
        this.render()
        return
    }
  }

  private current(): Level | undefined {
    return this.stack[this.stack.length - 1]
  }

  private render(): void {
    const level = this.current()
    if (!level) return

    const width = this.contentWidth()
    const rowWidth = Math.max(20, width - 1)
    const parts: Part[] = [
      header(level.title, this.stack.length > 1 ? "‹ back" : "", width),
      plain("\n"),
      rule(rowWidth),
      plain("\n"),
    ]

    level.items.forEach((item, i) => {
      if (i > 0) parts.push(plain("\n"))
      if (item.kind === "separator") {
        parts.push(plain("\n"))
        parts.push(sectionRule(item.label ?? "", rowWidth))
        return
      }

      const selected = i === this.index
      const marker = selected ? "❯" : " "
      const label = item.label.padEnd(LABEL_WIDTH)
      if (selected) {
        // Reverse video only renders correctly with an explicit default bg.
        parts.push(reverse(bold(fit(`${marker} ${label}${valueText(item)}`, rowWidth))))
      } else {
        parts.push(plain(`${marker} ${label}`))
        parts.push(valuePart(item))
      }
    })

    parts.push(plain("\n\n"))
    parts.push(dim("j/k move · l/Enter select · h back · g/G top/bottom · Esc close"))

    this.text.content = concat(parts)
    this.scroll.scrollTop = Math.max(0, (this.index - 4) * 1)
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

function valuePart(item: Exclude<MenuItem, { kind: "separator" }>): Part {
  switch (item.kind) {
    case "toggle": {
      const on = item.value()
      return on ? concat([fg(theme.green)("● "), plain("on")]) : concat([dim("○ "), dim("off")])
    }
    case "choice":
      return fg(theme.cyan)(item.value())
    case "submenu":
      return dim(`›  ${item.hint ?? ""}`.trimEnd())
    case "action": {
      const parts: Part[] = []
      if (item.checked) parts.push(fg(theme.green)("✓ "))
      if (item.hint) {
        parts.push(plain("  "))
        parts.push(dim(item.hint))
      }
      return concat(parts)
    }
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
