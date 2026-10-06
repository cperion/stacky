import {
  bold,
  BoxRenderable,
  dim,
  fg,
  ScrollBoxRenderable,
  t,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import { theme, scrollbarTheme } from "./theme.ts"
import { concat, plain, type Dimension, type Part } from "./render.ts"

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

  constructor(renderer: CliRenderer, opts: { width: Dimension }) {
    this.box = new BoxRenderable(renderer, {
      position: "absolute",
      left: "20%",
      top: "12%",
      width: opts.width,
      height: "74%",
      zIndex: 200,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.fg,
      titleColor: theme.fg,
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
      scrollbarOptions: scrollbarTheme,
    })
    this.text = new TextRenderable(renderer, { content: "", fg: theme.fg, wrapMode: "word" })
    this.scroll.add(this.text)
    this.box.add(this.scroll)
  }

  get isOpen(): boolean {
    return this.box.visible
  }

  open(title: string, items: MenuItem[]): void {
    this.stack = [{ title, items }]
    this.index = nextSelectable(items, -1, 1)
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

    const parts: Part[] = [t`${bold(level.title)}`, plain("\n\n")]

    level.items.forEach((item, i) => {
      if (i > 0) parts.push(plain("\n"))
      if (item.kind === "separator") {
        parts.push(t`${dim(`── ${item.label ?? ""}`.padEnd(LABEL_WIDTH + 6, "─"))}`)
        return
      }

      const selected = i === this.index
      const marker = selected ? "❯ " : "  "
      const label = item.label.padEnd(LABEL_WIDTH)
      const line = `${marker}${label}`
      parts.push(selected ? bold(line) : plain(line))
      parts.push(valuePart(item))
    })

    parts.push(plain("\n\n"))
    parts.push(dim("j/k move · l/Enter select/cycle · h back · g/G top/bottom · Esc close"))

    this.text.content = concat(parts)
    this.scroll.scrollTop = Math.max(0, (this.index - 4) * 1)
  }
}

function valuePart(item: Exclude<MenuItem, { kind: "separator" }>): Part {
  switch (item.kind) {
    case "toggle": {
      const on = item.value()
      const text = on ? "on" : "off"
      return on ? fg(theme.green)(text) : dim(text)
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
