import {
  bold,
  BoxRenderable,
  dim,
  fg,
  InputRenderable,
  ScrollBoxRenderable,
  t,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { AgentState, ConversationEntry, UserRequestRecord } from "../agent/types.ts"
import { theme, scrollbarTheme } from "./theme.ts"
import { clampLines, concat, plain, type Part } from "./render.ts"

export type ChatPaneOptions = {
  onSubmit: (text: string) => void
}

export class ChatPane {
  readonly box: BoxRenderable
  readonly input: InputRenderable
  private scroll: ScrollBoxRenderable
  private text: TextRenderable

  constructor(renderer: CliRenderer, opts: ChatPaneOptions) {
    this.box = new BoxRenderable(renderer, {
      flexGrow: 1,
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.fg,
      title: " CHAT ",
      titleColor: theme.fg,
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
      placeholder: "Type a message and press Enter…",
      backgroundColor: theme.bg,
      focusedBackgroundColor: theme.bg,
      textColor: theme.fg,
      focusedTextColor: theme.fg,
      placeholderColor: theme.gray,
      cursorColor: theme.fg,
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

  update(state: AgentState, selectedChoice: number): void {
    const parts: Part[] = []

    if (state.conversation.length === 0) {
      parts.push(dim("No conversation yet. Describe a task below to begin."))
    }

    for (const entry of state.conversation) {
      if (parts.length > 0) parts.push(plain("\n\n"))
      parts.push(...this.renderEntry(entry))
    }

    const pending = state.userRequest
    if (pending && state.mode === "waiting_for_user") {
      parts.push(plain("\n\n"))
      parts.push(...this.renderChoices(pending, selectedChoice))
    }

    this.text.content = concat(parts)
  }

  private renderEntry(entry: ConversationEntry): Part[] {
    switch (entry.role) {
      case "user":
        return [t`${bold(fg(theme.green)("You"))}`, plain("\n"), plain(entry.text)]
      case "agent":
        return [t`${bold(fg(theme.cyan)("Agent"))}`, plain("\n"), plain(entry.text)]
      case "action":
        return [dim(`→ ${entry.text}`)]
      case "observation":
        return [plain(clampLines(entry.text, 16))]
      case "protocol":
        return [fg(theme.red)(entry.text)]
    }
  }

  private renderChoices(request: UserRequestRecord, selected: number): Part[] {
    const parts: Part[] = [t`${bold(fg(theme.yellow)("Choose an option"))}`]
    const choices = request.choices ?? []
    choices.forEach((choice, index) => {
      const isSelected = index === selected
      const isPreferred = request.preferredChoice?.id === choice.id
      parts.push(plain("\n"))
      const marker = isSelected ? "❯" : " "
      const label = `${marker} ${index + 1}. ${choice.label}${isPreferred ? "  (recommended)" : ""}`
      parts.push(isSelected ? bold(label) : plain(label))
      if (choice.description) {
        parts.push(plain("\n"))
        parts.push(dim(`     ${choice.description}`))
      }
    })
    if (request.preferredChoice) {
      parts.push(plain("\n"))
      parts.push(dim(`Recommended: ${request.preferredChoice.id} — ${request.preferredChoice.reason}`))
    }
    parts.push(plain("\n"))
    parts.push(dim("↑/↓ to move · Enter to choose · or type a freeform reply"))
    return parts
  }
}
