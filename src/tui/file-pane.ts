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
import type { AgentState } from "../agent/types.ts"
import { theme } from "./theme.ts"
import { concat, formatTokens, plain, progressBar, type Dimension, type Part } from "./render.ts"

export class FilePane {
  readonly box: BoxRenderable
  private scroll: ScrollBoxRenderable
  private text: TextRenderable
  private budgetTokens: number

  constructor(renderer: CliRenderer, opts: { width: Dimension; budgetTokens: number }) {
    this.budgetTokens = opts.budgetTokens
    this.box = new BoxRenderable(renderer, {
      width: opts.width,
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.panel,
      title: " FILE WORKING SET ",
      titleColor: theme.cyan,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    })
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
    })
    this.text = new TextRenderable(renderer, {
      content: "",
      fg: theme.text,
      wrapMode: "word",
    })
    this.scroll.add(this.text)
    this.box.add(this.scroll)
  }

  update(state: AgentState): void {
    const used = state.files.reduce((total, file) => total + file.tokenCount, 0)
    const ratio = this.budgetTokens > 0 ? used / this.budgetTokens : 0
    const pressureColor = ratio > 0.9 ? theme.red : ratio > 0.7 ? theme.yellow : theme.green

    const parts: Part[] = [
      t`${bold(fg(theme.cyan)("TOKENS"))} ${formatTokens(used)} / ${formatTokens(this.budgetTokens)} ${dim(`(${Math.round(ratio * 100)}%)`)}`,
      plain("\n"),
      t`${fg(pressureColor)(progressBar(ratio))}`,
      plain("\n\n"),
      t`${bold(fg(theme.cyan)("HOT"))}`,
    ]

    if (state.files.length === 0) {
      parts.push(plain("\n"))
      parts.push(dim("(nothing read yet)"))
    } else {
      for (const file of state.files) {
        parts.push(plain("\n"))
        parts.push(t`${fg(theme.text)(file.path.padEnd(24))} ${dim(formatTokens(file.tokenCount))}`)
      }
    }

    parts.push(plain("\n\n"))
    parts.push(t`${bold(fg(theme.cyan)("COLD"))}`)
    parts.push(plain("\n"))
    parts.push(dim("eviction order: least recently used"))

    this.text.content = concat(parts)
    this.scroll.scrollTop = 0
  }
}
