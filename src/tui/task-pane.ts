import {
  bold,
  BoxRenderable,
  dim,
  fg,
  ScrollBoxRenderable,
  StyledText,
  t,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { AgentState, ClosedFrame, TaskFrame } from "../agent/types.ts"
import { theme } from "./theme.ts"
import { concat, plain, type Dimension, type Part } from "./render.ts"

export class TaskPane {
  readonly box: BoxRenderable
  private scroll: ScrollBoxRenderable
  private text: TextRenderable

  constructor(renderer: CliRenderer, opts: { width: Dimension }) {
    this.box = new BoxRenderable(renderer, {
      width: opts.width,
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.panel,
      title: " TASK STACK ",
      titleColor: theme.accent,
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

  update(state: AgentState, showHistory: boolean): void {
    const top = state.stack[state.stack.length - 1]
    const parents = state.stack.slice(0, -1)

    const parts: Part[] = []

    if (state.mode === "waiting_for_user") {
      parts.push(t`${bold(fg(theme.yellow)("⏸  WAITING FOR USER"))}`)
      parts.push(plain("\n"))
    }

    parts.push(t`${bold(fg(theme.accent)("TASK STACK"))} ${dim(`depth ${state.stack.length} · ${state.mode}`)}`)
    parts.push(plain("\n\n"))

    if (!top) {
      parts.push(dim("No active frame."))
      parts.push(plain("\n\n"))
      parts.push(dim("The next request will be framed with push()."))
    } else {
      parts.push(...this.renderTop(top, state.mode === "waiting_for_user"))
      if (parents.length > 0) parts.push(...this.renderParents(parents))
    }

    if (showHistory && state.closedFrames.length > 0) {
      parts.push(plain("\n\n"))
      parts.push(...this.renderHistory(state.closedFrames))
    }

    this.text.content = concat(parts)
    this.scroll.scrollTop = 0
  }

  private renderTop(frame: TaskFrame, waiting: boolean): Part[] {
    const color = waiting ? theme.yellow : theme.accent
    const parts: Part[] = [
      t`${bold(fg(color)("▶ TOP FRAME"))} ${dim(frame.id)}`,
      plain("\n"),
      t`${bold("Why")} ${frame.why}`,
      plain("\n"),
      t`${bold("Scope")} ${frame.scope}`,
      plain("\n"),
    ]
    parts.push(t`${bold("Known")} `)
    parts.push(frame.knownContext ? plain(frame.knownContext) : dim("(none)"))
    parts.push(plain("\n"))
    parts.push(t`${bold("Done when")} ${frame.definitionOfDone}`)
    return parts
  }

  private renderParents(parents: TaskFrame[]): Part[] {
    const parts: Part[] = [plain("\n\n"), t`${bold(fg(theme.dim)("PARENT FRAMES"))}`]
    for (const frame of [...parents].reverse()) {
      parts.push(plain("\n"))
      parts.push(t`${fg(theme.dim)("▸")} ${frame.why.split("\n")[0] ?? ""}`)
    }
    return parts
  }

  private renderHistory(history: ClosedFrame[]): Part[] {
    const parts: Part[] = [t`${bold(fg(theme.magenta)("FRAME HISTORY"))}`]
    for (const closed of [...history].reverse().slice(0, 12)) {
      parts.push(plain("\n"))
      parts.push(t`${fg(theme.green)("✓")} ${closed.intent.why.split("\n")[0] ?? ""}`)
      parts.push(plain("\n"))
      parts.push(dim(`   outcome: ${closed.disposition.outcome} — ${closed.disposition.whyClosed}`))
    }
    return parts
  }
}
