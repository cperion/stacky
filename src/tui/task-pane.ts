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
import type { AgentState, ClosedFrame, TaskFrame } from "../agent/types.ts"
import { theme, scrollbarOptions } from "./theme.ts"
import { concat, block, header, headerWith, paneRule, paneInner, plain, type Dimension, type Part } from "./render.ts"

export class TaskPane {
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

  update(state: AgentState, showHistory: boolean): void {
    const width = paneInner(this.box, this.renderer, 0.26)
    const top = state.stack[state.stack.length - 1]
    const parents = state.stack.slice(0, -1)

    const parts: Part[] = []
    const waiting = state.mode === "waiting_for_user"

    if (waiting) {
      parts.push(
        headerWith("TASK STACK", bold(fg(theme.yellow)("waiting for user")), "waiting for user".length, width),
      )
    } else {
      parts.push(header("TASK STACK", `depth ${state.stack.length} · ${state.mode}`, width))
    }
    parts.push(plain("\n"), paneRule(width), plain("\n"))

    if (!top) {
      parts.push(plain("\n"))
      parts.push(dim("No active frame."))
      parts.push(plain("\n\n"))
      parts.push(dim("Describe a task below and the agent will push a frame."))
    } else {
      parts.push(plain("\n"))
      parts.push(...this.renderTop(top, waiting, width))
      if (parents.length > 0) parts.push(...this.renderParents(parents, width))
    }

    if (showHistory && state.closedFrames.length > 0) {
      parts.push(plain("\n\n"))
      parts.push(...this.renderHistory(state.closedFrames, width))
    }

    this.text.content = concat(parts)
    this.scroll.scrollTop = 0
  }

  private renderTop(frame: TaskFrame, waiting: boolean, width: number): Part[] {
    const color = waiting ? theme.yellow : theme.blue
    const parts: Part[] = [
      t`${fg(color)("▌")} ${bold(fg(color)("TOP FRAME"))}  ${dim(frame.id)}`,
      plain("\n\n"),
    ]
    parts.push(...this.field("Why", frame.why, width))
    parts.push(...this.field("Scope", frame.scope, width))
    parts.push(...this.field("Known", frame.knownContext || "—", width))
    parts.push(...this.field("Done when", frame.definitionOfDone, width))
    return parts
  }

  private field(label: string, value: string, width: number): Part[] {
    return [bold(label), plain("\n"), plain(block(value, width, 2)), plain("\n\n")]
  }

  private renderParents(parents: TaskFrame[], width: number): Part[] {
    const parts: Part[] = [plain("\n"), header("PARENTS", `${parents.length}`, width), plain("\n"), paneRule(width), plain("\n")]
    for (const frame of [...parents].reverse()) {
      parts.push(plain("\n"), t`${dim("·")} ${frame.why.split("\n")[0] ?? ""}`)
    }
    return parts
  }

  private renderHistory(history: ClosedFrame[], width: number): Part[] {
    const parts: Part[] = [header("HISTORY", `${history.length}`, width), plain("\n"), paneRule(width)]
    for (const closed of [...history].reverse().slice(0, 15)) {
      parts.push(plain("\n"))
      parts.push(t`${fg(theme.green)("✓")} ${closed.intent.why.split("\n")[0] ?? ""}`)
      parts.push(plain("\n"))
      parts.push(dim(`  ${closed.disposition.outcome} · ${closed.disposition.whyClosed}`))
      parts.push(plain("\n"))
    }
    return parts
  }
}
