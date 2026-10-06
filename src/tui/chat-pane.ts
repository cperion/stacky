import {
  bold,
  bg,
  BoxRenderable,
  dim,
  fg,
  InputRenderable,
  italic,
  reverse,
  ScrollBoxRenderable,
  t,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { AgentState, ConversationEntry, StreamingState, UserRequestRecord } from "../agent/types.ts"
import { theme, scrollbarTheme } from "./theme.ts"
import { block, paneInner, clampLines, concat, fit, header, padLines, paneRule, plain, wrapRaw, type Part } from "./render.ts"

export type ChatPaneOptions = {
  onSubmit: (text: string) => void
}

export class ChatPane {
  readonly box: BoxRenderable
  readonly input: InputRenderable
  private scroll: ScrollBoxRenderable
  private text: TextRenderable

  constructor(
    private renderer: CliRenderer,
    opts: ChatPaneOptions,
  ) {
    this.box = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.blue,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    })

    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollbarOptions: scrollbarTheme,
    })
    this.text = new TextRenderable(renderer, { content: "", fg: theme.fg, bg: theme.bg, wrapMode: "word" })
    this.scroll.add(this.text)

    this.input = new InputRenderable(renderer, {
      placeholder: "Message the agent…",
      backgroundColor: theme.bg,
      focusedBackgroundColor: theme.bg,
      textColor: theme.fg,
      focusedTextColor: theme.fg,
      placeholderColor: theme.gray,
      cursorColor: theme.blue,
    })
    // InputRenderable.submit() overrides Textarea.submit() and does NOT call
    // onSubmit — it emits an "enter" event with the submitted value instead.
    this.input.on("enter", (value: string) => {
      this.input.value = ""
      opts.onSubmit(value)
    })

    this.box.add(this.scroll)
    this.box.add(this.input)
  }

  focus(): void {
    this.input.focus()
  }

  update(state: AgentState, selectedChoice: number, showThinking: boolean): void {
    const width = paneInner(this.box, this.renderer, 0.5)
    const parts: Part[] = [header("CHAT", `${state.conversation.length} entries`, width), plain("\n"), paneRule(width), plain("\n")]

    if (state.conversation.length === 0) {
      parts.push(plain("\n"), dim("No conversation yet. Describe a task below to begin."))
    }

    for (const entry of state.conversation) {
      if (entry.role === "thinking" && !showThinking) continue
      parts.push(plain("\n\n"))
      parts.push(...this.renderEntry(entry, width))
    }

    const streaming = state.streaming
    if (streaming?.active) {
      parts.push(plain("\n\n"))
      parts.push(...this.renderStreaming(streaming, showThinking, width))
    }

    const pending = state.userRequest
    if (pending && state.mode === "waiting_for_user") {
      parts.push(plain("\n\n"))
      parts.push(...this.renderChoices(pending, selectedChoice, width))
    }

    this.text.content = concat(parts)
  }

  private bar(color: ReturnType<typeof fg>, label: string): Part {
    return t`${color("▌")} ${bold(label)}`
  }

  private renderEntry(entry: ConversationEntry, width: number): Part[] {
    switch (entry.role) {
      case "user":
        return [this.bar(fg(theme.green), "You"), plain("\n"), plain(block(entry.text, width, 2))]
      case "agent":
        return [this.bar(fg(theme.cyan), "Agent"), plain("\n"), plain(block(entry.text, width, 2))]
      case "thinking":
        return [
          this.bar(fg(theme.magenta), "Thinking"),
          plain("\n"),
          italic(dim(block(clampLines(entry.text, 40), width, 2, "│"))),
        ]
      case "action":
        return this.renderAction(entry.text, width)
      case "observation":
        return [bg(theme.panel)(padLines(block(clampLines(entry.text, 16), width, 2, "│"), width))]
      case "protocol":
        return [fg(theme.red)(block(entry.text, width, 2, "✗"))]
    }
  }

  /** Tool calls are the agent's actions: render them prominently, args subordinate. */
  private renderAction(text: string, width: number): Part[] {
    const paren = text.indexOf("(")
    const tool = paren >= 0 ? text.slice(0, paren) : text
    const args = paren >= 0 ? text.slice(paren) : ""
    const prefix = "  → "
    const hanging = prefix.length + tool.length + 2
    const argLines = wrapRaw(args, Math.max(8, width - hanging))

    const parts: Part[] = [
      concat([fg(theme.blue)(prefix), bold(fg(theme.blue)(tool)), plain("  "), dim(argLines[0] ?? "")]),
    ]
    for (const line of argLines.slice(1)) {
      parts.push(plain(`\n${" ".repeat(hanging)}`))
      parts.push(dim(line))
    }
    return parts
  }

  private renderStreaming(streaming: StreamingState, showThinking: boolean, width: number): Part[] {
    const parts: Part[] = []
    if (streaming.reasoning && showThinking) {
      parts.push(this.bar(fg(theme.magenta), "Thinking"))
      parts.push(plain("\n"))
      parts.push(italic(dim(block(streaming.reasoning, width, 2, "│"))))
      parts.push(plain("\n"))
    }
    if (streaming.text) {
      if (parts.length > 0) parts.push(plain("\n"))
      parts.push(this.bar(fg(theme.cyan), "Agent"))
      parts.push(plain("\n"))
      parts.push(plain(block(streaming.text, width, 2)))
      parts.push(plain("\n"))
    }
    if (streaming.tool) {
      parts.push(concat([fg(theme.blue)("  → "), bold(fg(theme.blue)(streaming.tool)), dim("  running…")]))
    } else if (!streaming.reasoning && !streaming.text) {
      parts.push(dim("  …"))
    }
    return parts
  }

  private renderChoices(request: UserRequestRecord, selected: number, width: number): Part[] {
    const parts: Part[] = [paneRule(width), plain("\n"), bold("Needs your input"), plain("\n\n")]
    const choices = request.choices ?? []
    choices.forEach((choice, index) => {
      const isSelected = index === selected
      const isPreferred = request.preferredChoice?.id === choice.id
      const marker = isSelected ? "❯" : " "
      const tag = isPreferred ? "  recommended" : ""
      const label = `${marker} ${index + 1}. ${choice.label}${tag}`
      wrapRaw(label, width - 1).forEach((line, i) => {
        if (i > 0) parts.push(plain("\n"))
        parts.push(isSelected ? reverse(bold(fit(line, width - 1))) : plain(line))
      })
      parts.push(plain("\n"))
      if (choice.description) {
        parts.push(plain(block(choice.description, width, 5)))
        parts.push(plain("\n"))
      }
    })
    if (request.preferredChoice) {
      parts.push(plain("\n"), dim(block(`recommended · ${request.preferredChoice.reason}`, width, 0)), plain("\n"))
    }
    parts.push(plain("\n"), dim("j/k move · l/Enter select · or type a reply"))
    return parts
  }
}

