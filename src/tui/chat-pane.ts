import {
  bold,
  BoxRenderable,
  dim,
  fg,
  TextareaRenderable,
  italic,
  reverse,
  ScrollBoxRenderable,
  StyledText,
  t,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import { formatUserMessage } from "../agent/runtime.ts"
import type { AgentState, ConversationEntry, StreamingState, UserRequestRecord } from "../agent/types.ts"
import { theme, scrollbarOptions } from "./theme.ts"
import { block, clampLines, concat, fit, paneInner, paneRule, plain, prefixLines, quoteBlock, wrapRaw, type Part } from "./render.ts"
import { renderMarkdown } from "./markdown.ts"
import { renderToolCall } from "./action.ts"
import { Composer } from "./composer.ts"
import type { ProviderName } from "../llm/providers.ts"

export type ChatPaneOptions = {
  onSubmit: (text: string) => void
  canSubmit?: (text: string) => boolean
  provider: () => ProviderName
}

/**
 * Chat pane. Each transcript block is its own renderable so that shaded blocks
 * (user input and tool output) get a real full-width background box rather than
 * relying on padded spaces.
 */
export class ChatPane {
  readonly box: BoxRenderable
  readonly input: TextareaRenderable
  readonly composer: Composer
  private scroll: ScrollBoxRenderable
  private blocks = 0
  private lastTranscript = ""

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
      scrollbarOptions: scrollbarOptions(),
    })

    this.composer = new Composer(renderer, opts)
    this.input = this.composer.input
    this.box.add(this.scroll)
    this.box.add(this.composer.box)
  }

  focus(): void {
    this.input.focus()
  }

  scrollPage(direction: -1 | 1): void {
    this.scroll.scrollBy(direction * Math.max(1, this.scroll.height - 2))
  }

  update(state: AgentState, selectedChoice: number, showThinking: boolean): void {
    const width = paneInner(this.box, this.renderer, 0.5)
    const signature = JSON.stringify([width, state.conversation, state.streaming, state.toolOutput, state.userRequest, state.mode, selectedChoice, showThinking])
    if (signature === this.lastTranscript) return
    this.lastTranscript = signature
    this.clear()

    if (state.conversation.length === 0) {
      this.addBlock(concat([bold("stacky"), plain("\n\nDescribe what you want to build or fix."), plain("\n\n"), dim("/model to switch · /help for commands")]), false)
    }

    const pending = state.mode === "waiting_for_user" ? state.userRequest : undefined
    const activeQuestion = pending?.choices?.length
      ? state.conversation.findLast((entry) => entry.role === "agent" && entry.text === formatUserMessage(pending))?.id
      : undefined
    for (const entry of state.conversation) {
      if (entry.role === "thinking" && !showThinking) continue
      const shaded = entry.role === "user" || entry.role === "observation"
      // The active selector owns the options. Once answered, the original full
      // question remains in history; no runtime/prompt data is discarded.
      const display = entry.id === activeQuestion && pending ? { ...entry, text: pending.message } : entry
      this.addBlock(this.renderEntry(display, width), shaded)
    }

    const streaming = state.streaming
    if (streaming?.active) this.addBlock(this.renderStreaming(streaming, showThinking, width), false)
    if (state.activeTool === "bash" && state.toolOutput) {
      this.addBlock(concat([dim(`  │ ${state.toolOutput}`)]), false)
    }

    if (pending?.choices?.length) {
      this.addBlock(this.renderChoices(pending, selectedChoice, width), false)
    }
  }

  /** Replace all transcript blocks. */
  private clear(): void {
    for (const child of [...this.scroll.getChildren()]) {
      this.scroll.remove(child)
      child.destroyRecursively()
    }
    this.blocks = 0
  }

  /**
   * Add one transcript block. Shaded blocks are wrapped in a full-width box so
   * the background tint spans every line to the edge of the pane.
   */
  private addBlock(content: StyledText, shaded: boolean): void {
    if (this.blocks > 0) {
      this.scroll.add(new TextRenderable(this.renderer, { content: " ", fg: theme.fg, bg: theme.bg }))
    }
    const text = new TextRenderable(this.renderer, {
      content,
      fg: theme.fg,
      bg: shaded ? theme.shade : theme.bg,
      wrapMode: "none",
    })
    if (shaded) {
      const container = new BoxRenderable(this.renderer, {
        width: "100%",
        flexDirection: "column",
        backgroundColor: theme.shade,
      })
      container.add(text)
      this.scroll.add(container)
    } else {
      this.scroll.add(text)
    }
    this.blocks += 1
  }

  private bar(color: ReturnType<typeof fg>, label: string): Part {
    return t`${color("✻")} ${bold(label)}`
  }

  private renderEntry(entry: ConversationEntry, width: number): StyledText {
    switch (entry.role) {
      case "user":
        return prefixLines(renderMarkdown(entry.text, width - 2, 0), "▌ ", theme.green)
      case "agent":
        // The agent is the default voice: no marker. The user's green bar (and the
        // shaded tint on user input) is what distinguishes the two.
        return renderMarkdown(entry.text, width, 0)
      case "thinking":
        return concat([
          this.bar(fg(theme.magenta), "Thinking"),
          plain("\n"),
          italic(dim(block(clampLines(entry.text, 40), width, 2, "│"))),
        ])
      case "action":
        return renderToolCall(entry, width)
      case "observation":
        return quoteBlock(clampLines(entry.text, 16), width, theme.dim)
      case "note":
        return concat([dim(block(entry.text, width, 0))])
      case "subagent": {
        const marker = `${"│ ".repeat(Math.max(0, (entry.depth ?? 1) - 1))}⤷ `
        const inner = entry.subrole ?? "observation"
        if (inner === "action") return concat([dim(marker), renderToolCall({ text: entry.text, ...(entry.tool ? { tool: entry.tool } : {}) }, width)])
        if (inner === "observation") return concat([dim(marker + entry.text)])
        if (inner === "agent") return concat([dim(marker), plain(block(entry.text, width - marker.length, 0))])
        return concat([dim(marker + entry.text)])
      }
      case "protocol":
        return concat([fg(theme.red)(block(entry.text, width, 2, "✗"))])
    }
  }

  private renderStreaming(streaming: StreamingState, showThinking: boolean, width: number): StyledText {
    const parts: Part[] = []
    if (streaming.reasoning && showThinking) {
      parts.push(this.bar(fg(theme.magenta), "Thinking"))
      parts.push(plain("\n"))
      parts.push(italic(dim(block(streaming.reasoning, width, 2, "│"))))
      parts.push(plain("\n"))
    }
    if (streaming.text) {
      if (parts.length > 0) parts.push(plain("\n"))
      parts.push(renderMarkdown(streaming.text, width, 0))
      parts.push(plain("\n"))
    }
    if (streaming.tool) {
      parts.push(concat([fg(theme.blue)("  → "), bold(fg(theme.blue)(streaming.tool)), dim("  running…")]))
    } else if (!streaming.reasoning && !streaming.text) {
      parts.push(dim("  …"))
    }
    return concat(parts)
  }

  private renderChoices(request: UserRequestRecord, selected: number, width: number): StyledText {
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
    return concat(parts)
  }
}
