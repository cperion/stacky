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
import { theme, scrollbarTheme } from "./theme.ts"
import { concat, formatTokens, header, paneRule, paneInner, plain, progressBar, type Dimension, type Part } from "./render.ts"

export class FilePane {
  readonly box: BoxRenderable
  private scroll: ScrollBoxRenderable
  private text: TextRenderable

  constructor(
    private renderer: CliRenderer,
    opts: { width: Dimension },
  ) {
    this.box = new BoxRenderable(renderer, {
      width: opts.width,
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.dim,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
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

  update(state: AgentState, budgetTokens: number): void {
    const width = paneInner(this.box, this.renderer, 0.26)
    const used = state.files.reduce((total, file) => total + file.tokenCount, 0)
    const ratio = budgetTokens > 0 ? used / budgetTokens : 0
    const pressure = ratio > 0.9 ? theme.red : ratio > 0.7 ? theme.yellow : theme.green
    const percent = `${Math.round(ratio * 100)}%`

    const parts: Part[] = [
      header("FILE WORKING SET", `${state.files.length} file${state.files.length === 1 ? "" : "s"}`, width),
      plain("\n"),
      paneRule(width),
      plain("\n\n"),
      t`${bold(formatTokens(used))} ${dim(`/ ${formatTokens(budgetTokens)}`)}  ${fg(pressure)(percent)}`,
      plain("\n"),
      fg(pressure)(progressBar(ratio, Math.max(8, width - 2))),
      plain("\n\n"),
    ]

    if (state.files.length === 0) {
      parts.push(dim("Nothing read yet."))
    } else {
      parts.push(header("HOT", "", width))
      parts.push(plain("\n"))
      const nameWidth = Math.max(6, width - 7)
      for (const file of state.files) {
        const name = file.path.length > nameWidth ? `…${file.path.slice(-(nameWidth - 1))}` : file.path.padEnd(nameWidth)
        parts.push(plain("\n"), concat([plain(name), plain(" "), dim(formatTokens(file.tokenCount))]))
      }
      parts.push(plain("\n\n"))
      parts.push(dim("Evicted least-recently-used first."))
    }

    this.text.content = concat(parts)
    this.scroll.scrollTop = 0
  }
}
