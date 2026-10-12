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
import { theme, scrollbarOptions } from "./theme.ts"
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
      scrollbarOptions: scrollbarOptions(),
    })
    this.text = new TextRenderable(renderer, { content: "", fg: theme.fg, wrapMode: "word" })
    this.scroll.add(this.text)
    this.box.add(this.scroll)
  }

  update(state: AgentState, budgetTokens: number): void {
    const width = paneInner(this.box, this.renderer, 0.26)
    const used = state.memory?.usedTokens ?? state.files.reduce((total, file) => total + file.tokenCount, 0)
    const ratio = budgetTokens > 0 ? used / budgetTokens : 0
    const pressure = ratio > 0.9 ? theme.red : ratio > 0.7 ? theme.yellow : theme.dim
    const percent = `${Math.round(ratio * 100)}%`

    const parts: Part[] = [
      header("CONTEXT", `${state.memory?.views ?? state.files.length} views`, width),
      plain("\n"),
      paneRule(width),
      plain("\n\n"),
      t`${bold(formatTokens(used))} ${dim(`/ ${formatTokens(budgetTokens)}`)}  ${fg(pressure)(percent)}`,
      plain("\n"),
      fg(pressure)(progressBar(ratio, Math.max(8, width - 2))),
      plain("\n\n"),
    ]

    if (state.files.length === 0) {
      parts.push(dim("No live file views."))
    } else {
      const nameWidth = Math.max(6, width - 7)
      for (const file of state.files) {
        const name = file.path.length > nameWidth ? `…${file.path.slice(-(nameWidth - 1))}` : file.path.padEnd(nameWidth)
        parts.push(plain("\n"), concat([plain(name), plain(" "), dim(formatTokens(file.tokenCount))]))
      }
      parts.push(plain("\n\n"))
      parts.push(dim("Live files · oldest attention evicted first."))
    }

    const archived = state.memory ? state.memory.views - state.memory.liveViews : 0
    if (archived > 0) parts.push(plain("\n\n"), dim(`${archived} read-only view(s) · /context to inspect`))
    this.text.content = concat(parts)
  }
}
