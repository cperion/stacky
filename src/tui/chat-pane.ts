import {
  bold,
  BoxRenderable,
  dim,
  fg,
  InputRenderable,
  italic,
  ScrollBoxRenderable,
  t,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { AgentState, ConversationEntry, StreamingState, UserRequestRecord } from "../agent/types.ts"
import { theme, scrollbarTheme } from "./theme.ts"
import { block, clampLines, concat, header, innerWidth, plain, rule, type Part } from "./render.ts"

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
    this.text = new TextRenderable(renderer, { content: "", fg: theme.fg, wrapMode: "word" })
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
    const width = innerWidth(this.box, this.renderer, 0.5)
    const parts: Part[] = [header("CHAT", `${state.conversation.length} entries`, width), plain("\n"), rule(width), plain("\n")]

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
        return [dim(block(entry.text, width, 2, "→"))]
      case "observation":
        return [dim(block(clampLines(entry.text, 16), width, 2, "│"))]
      case "protocol":
        return [fg(theme.red)(block(entry.text, width, 2, "✗"))]
    }
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
      parts.push(dim(`  → calling ${streaming.tool}…`))
    } else if (!streaming.reasoning && !streaming.text) {
      parts.push(dim("  …"))
    }
    return parts
  }

  private renderChoices(request: UserRequestRecord, selected: number, width: number): Part[] {
    const parts: Part[] = [rule(width), plain("\n"), bold("Needs your input"), plain("\n\n")]
    const choices = request.choices ?? []
    choices.forEach((choice, index) => {
      const isSelected = index === selected
      const isPreferred = request.preferredChoice?.id === choice.id
      const marker = isSelected ? fg(theme.blue)("❯") : plain(" ")
      const label = `${index + 1}. ${choice.label}`
      parts.push(marker, plain(" "))
      parts.push(isSelected ? bold(label) : plain(label))
      if (isPreferred) parts.push(plain("  "), fg(theme.green)("recommended"))
      if (choice.description) {
        parts.push(plain("\n     "), dim(choice.description))
      }
      parts.push(plain("\n"))
    })
    if (request.preferredChoice) {
      parts.push(plain("\n"), dim(`recommended · ${request.preferredChoice.reason}`), plain("\n"))
    }
    parts.push(plain("\n"), dim("j/k move · l/Enter select · or type a reply"))
    return parts
  }
}

