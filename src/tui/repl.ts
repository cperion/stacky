import {
  bold,
  BoxRenderable,
  createCliRenderer,
  dim,
  fg,
  InputRenderable,
  italic,
  StyledText,
  TextRenderable,
} from "@opentui/core"
import type { AgentRuntime } from "../agent/runtime.ts"
import type { AgentState, ConversationEntry, StreamingState } from "../agent/types.ts"
import { applyTheme, theme } from "./theme.ts"
import { block, clampLines, concat, fit, formatTokens, plain, prefixLines, quoteBlock, wrapRaw, type Part } from "./render.ts"
import { renderMarkdown } from "./markdown.ts"
import { renderToolCall } from "./action.ts"
import { renderChip, statusChip, TOOL_FLASH_MS } from "./status.ts"
import { historyStripe } from "./history.ts"
import type { SettingsController, UiResult } from "./settings.ts"
import { runCommand, type CommandContext } from "./commands.ts"

export type ReplOptions = {
  runtime: AgentRuntime
  settings: SettingsController
  initialTask?: string
  notice?: string
}


/**
 * REPL interface: output flows into the terminal's real scrollback and only a
 * compact status + prompt footer stays pinned at the bottom. Slash commands
 * replace the settings menu.
 */
export async function runRepl(opts: ReplOptions): Promise<UiResult> {
  let result: UiResult = "quit"
  let resolveDone: (value: UiResult) => void = () => {}
  const done = new Promise<UiResult>((resolve) => {
    resolveDone = resolve
  })

  const renderer = await createCliRenderer({
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    footerHeight: 8,
    exitOnCtrlC: true,
    targetFps: 30,
    useMouse: false,
    onDestroy: () => {
      clearInterval(ticker)
      resolveDone(result)
    },
  })

  await applyTheme(renderer, opts.settings.config.theme)

  // ---- footer (dashboard) -------------------------------------------------

  const footer = new BoxRenderable(renderer, { width: "100%", height: 3, flexDirection: "column" })
  let footerRows = 3
  const status = new TextRenderable(renderer, { content: "", fg: theme.fg, bg: theme.bg, wrapMode: "none", height: 1 })
  const historyLine = new TextRenderable(renderer, { content: "", fg: theme.fg, bg: theme.bg, wrapMode: "none", height: 0 })
  const dashboard = new TextRenderable(renderer, { content: "", fg: theme.fg, bg: theme.bg, wrapMode: "none", height: 0 })
  const live = new TextRenderable(renderer, { content: "", fg: theme.fg, bg: theme.bg, wrapMode: "none", height: 1 })
  const promptRow = new BoxRenderable(renderer, { width: "100%", height: 1, flexDirection: "row" })
  promptRow.add(
    new TextRenderable(renderer, {
      content: concat([fg(theme.green)("❯ ")]),
      fg: theme.fg,
      bg: theme.bg,
      wrapMode: "none",
      width: 2,
    }),
  )
  const input = new InputRenderable(renderer, {
    placeholder: "message, or /help",
    backgroundColor: theme.bg,
    focusedBackgroundColor: theme.bg,
    textColor: theme.fg,
    focusedTextColor: theme.fg,
    placeholderColor: theme.gray,
    cursorColor: theme.green,
    flexGrow: 1,
  })
  promptRow.add(input)
  footer.add(historyLine)
  footer.add(dashboard)
  footer.add(live)
  footer.add(promptRow)
  footer.add(status)
  renderer.root.add(footer)
  input.focus()

  // ---- scrollback output --------------------------------------------------

  const rendererWidth = () => Math.max(20, renderer.width - 1)

  const writeBlock = (content: StyledText, shaded: boolean, trailingBlank = true): void => {
    // writeToScrollback uses the root's height before layout, so compute it from
    // the content itself (one row per line, plus an optional blank separator).
    const lineCount = content.chunks.reduce((n, chunk) => n + (chunk.text.split("\n").length - 1), 0) + 1
    const height = lineCount + (trailingBlank ? 1 : 0)
    renderer.writeToScrollback((ctx) => {
      const root = new BoxRenderable(ctx.renderContext, {
        width: ctx.width,
        flexDirection: "column",
        backgroundColor: "transparent",
        shouldFill: false,
      })
      const text = new TextRenderable(ctx.renderContext, {
        content,
        fg: theme.fg,
        bg: shaded ? theme.shade : "transparent",
        wrapMode: "none",
      })
      if (shaded) {
        // A full-width background box so the tint spans every line to the edge.
        const panel = new BoxRenderable(ctx.renderContext, {
          width: ctx.width,
          flexDirection: "column",
          backgroundColor: theme.shade,
        })
        panel.add(text)
        root.add(panel)
      } else {
        root.add(text)
      }
      if (trailingBlank) {
        root.add(new TextRenderable(ctx.renderContext, { content: " ", fg: theme.fg, bg: "transparent" }))
      }
      return { root, height, startOnNewLine: true, trailingNewline: true }
    })
  }

  const entryParts = (entry: ConversationEntry, width: number, showThinking: boolean): StyledText | undefined => {
    switch (entry.role) {
      case "user":
        return prefixLines(renderMarkdown(entry.text, width - 2, 0), "▌ ", theme.green)
      case "agent":
        return renderMarkdown(entry.text, width, 0)
      case "thinking":
        if (!showThinking) return undefined
        return concat([
          fg(theme.magenta)("✻ "),
          bold("Thinking"),
          plain("\n"),
          italic(dim(block(clampLines(entry.text, 40), width, 2, "│"))),
        ])
      case "action":
        return renderToolCall(entry, width)
      case "observation":
        return quoteBlock(clampLines(entry.text, 16), width, theme.dim)
      case "protocol":
        return concat([fg(theme.red)("✗ "), fg(theme.red)(block(entry.text, width, 2))])
      case "note":
        return concat([fg(theme.yellow)("⏹ "), dim(entry.text)])
      case "subagent": {
        const marker = `${"│ ".repeat(Math.max(0, (entry.depth ?? 1) - 1))}⤷ `
        const inner = entry.subrole ?? "observation"
        if (inner === "action") return concat([dim(marker), renderToolCall({ text: entry.text, ...(entry.tool ? { tool: entry.tool } : {}) }, width)])
        if (inner === "agent") return concat([dim(marker), plain(block(entry.text, width - marker.length, 0))])
        return concat([dim(marker + entry.text)])
      }
    }
  }

  const printedIds = new Set<string>()
  const flushConversation = (state: AgentState): void => {
    for (const entry of state.conversation) {
      if (printedIds.has(entry.id)) continue
      printedIds.add(entry.id)
      const parts = entryParts(entry, rendererWidth(), opts.settings.config.showThinking)
      if (parts) writeBlock(parts, entry.role === "user" || entry.role === "observation")
    }
  }

  const writeLine = (parts: Part[], trailingBlank = false): void => {
    writeBlock(concat(parts), false, trailingBlank)
  }

  // ---- footer rendering ---------------------------------------------------

  let selectedChoice = 0
  let choiceRequestId: string | undefined

  const choiceRequest = (state: AgentState) => {
    const pending = state.userRequest
    if (state.mode === "waiting_for_user" && pending?.choices?.length) return pending
    return undefined
  }

  const moveChoice = (state: AgentState, delta: number): void => {
    const pending = choiceRequest(state)
    const count = pending?.choices?.length ?? 0
    if (count === 0) return
    selectedChoice = (selectedChoice + delta + count) % count
    updateFooter(state)
  }

  const updateFooter = (state: AgentState): void => {
    const m = state.metrics
    const meta = `${opts.runtime.llmLabel}${opts.settings.config.thinking ? " · thinking" : ""} · llm ${m.llmCalls} · tools ${m.toolCalls}`
    status.content = concat([
      renderChip(statusChip(state)),
      plain("  "),
      dim(meta),
      plain("   "),
      dim("ctrl+c quit · Esc interrupts · /help"),
    ])

    const pane = buildDashboard(
      state,
      rendererWidth(),
      opts.settings.config.replDashboard,
      opts.settings.config.fileBudgetTokens,
    )
    dashboard.content = pane
    const rows = countLines(pane)
    dashboard.height = rows

    const stripe = historyStripe(state, rendererWidth())
    historyLine.content = concat(stripe)
    const stripeRows = stripe.length > 0 ? 2 : 0
    historyLine.height = stripeRows

    // Only touch the split-footer size when it actually changes — resizing it on
    // every tick disturbs the scroll region.
    const total = stripeRows + rows + 3
    if (total !== footerRows) {
      footerRows = total
      footer.height = total
      renderer.footerHeight = total
    }

    live.content = liveContent(state)
  }

  const liveContent = (state: AgentState): StyledText => {
    const pending = choiceRequest(state)
    if (pending) {
      const choice = pending.choices?.[selectedChoice]
      const total = pending.choices?.length ?? 0
      if (choice) {
        return concat([
          fg(theme.blue)("❯ "),
          bold(`${selectedChoice + 1}. ${choice.label}`),
          dim(`   (${total} option${total === 1 ? "" : "s"} · j/k move · l/Enter select · or type a reply)`),
        ])
      }
    }
    if (state.activeTool === "bash" && state.toolOutput) {
      return concat([dim("│ "), dim(tail(state.toolOutput, rendererWidth() - 3))])
    }
    const streaming = state.streaming
    if (streaming?.active) return streamingLine(streaming, rendererWidth())
    return plain("")
  }

  const streamingLine = (streaming: StreamingState, width: number): StyledText => {
    if (streaming.reasoning && opts.settings.config.showThinking) {
      return concat([fg(theme.magenta)("✻ "), italic(dim(tail(streaming.reasoning, width - 4)))])
    }
    if (streaming.text) return plain(tail(streaming.text, width - 2))
    if (streaming.tool) return concat([fg(theme.blue)("→ "), bold(fg(theme.blue)(streaming.tool)), dim(" running…")])
    return concat([dim("…")])
  }

  // ---- commands -----------------------------------------------------------

  const print = (parts: Part[]): void => writeLine(parts, true)

  const commandContext: CommandContext = {
    runtime: opts.runtime,
    settings: opts.settings,
    print: (text) => print([plain(text)]),
    switchUi: (mode) => {
      result = "switch"
      opts.settings.config.ui = mode
      opts.settings.persist()
      renderer.destroy()
    },
    quit: () => {
      result = "quit"
      renderer.destroy()
    },
  }

  // ---- submitting ---------------------------------------------------------

  const submit = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    const state = opts.runtime.snapshot()
    const choicesPending = state.mode === "waiting_for_user" && (state.userRequest?.choices?.length ?? 0) > 0

    if (!trimmed && !choicesPending) return

    if (trimmed.startsWith("/")) {
      history.push(trimmed)
      historyIndex = history.length
      runCommand(trimmed, commandContext)
      return
    }

    const pending = state.userRequest
    if (state.mode === "waiting_for_user" && pending?.choices?.length) {
      if (trimmed === "") {
        const choice = pending.choices[selectedChoice] ?? pending.choices[0]
        if (choice) text = choice.label
      } else {
        const numeric = Number(trimmed)
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= pending.choices.length) {
          text = pending.choices[numeric - 1]!.label
        }
      }
    } else if (trimmed === "") {
      return
    }

    history.push(text)
    historyIndex = history.length
    try {
      await opts.runtime.request(text)
    } catch (error) {
      print([fg(theme.red)(error instanceof Error ? error.message : String(error))])
    }
  }

  input.on("enter", (value: string) => {
    input.value = ""
    void submit(value)
  })

  const history: string[] = []
  let historyIndex = 0

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      if (opts.runtime.isRunning) opts.runtime.interrupt()
      else if (input.value.length > 0) input.value = ""
      return
    }

    const state = opts.runtime.snapshot()
    const choiceActive = state.mode === "waiting_for_user" && (state.userRequest?.choices?.length ?? 0) > 0
    const inputEmpty = input.value.length === 0

    // Vim motions drive the choice list while the prompt is empty, matching the
    // panes interface. With text in the prompt, j/k/l are ordinary characters.
    if (choiceActive && inputEmpty) {
      if (key.name === "j" || key.name === "down") {
        moveChoice(state, 1)
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (key.name === "k" || key.name === "up") {
        moveChoice(state, -1)
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (key.name === "l") {
        const pending = state.userRequest
        const choice = pending?.choices?.[selectedChoice]
        if (choice) void submit(choice.label)
        key.preventDefault()
        key.stopPropagation()
        return
      }
    }

    if (key.name === "up" && inputEmpty && history.length > 0) {
      historyIndex = Math.max(0, historyIndex - 1)
      input.value = history[historyIndex] ?? ""
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (key.name === "down" && inputEmpty) {
      historyIndex = Math.min(history.length, historyIndex + 1)
      input.value = history[historyIndex] ?? ""
      key.preventDefault()
      key.stopPropagation()
    }
  })

  // ---- wiring -------------------------------------------------------------

  const onState = (): void => {
    const state = opts.runtime.snapshot()
    const pending = state.userRequest
    if (pending && state.mode === "waiting_for_user" && pending.id !== choiceRequestId) {
      choiceRequestId = pending.id
      const preferred = pending.preferredChoice?.id
      const index = pending.choices?.findIndex((choice) => choice.id === preferred) ?? -1
      selectedChoice = index >= 0 ? index : 0
    }
    if (!pending) choiceRequestId = undefined
    flushConversation(state)
    updateFooter(state)
  }

  opts.runtime.bus.on((event) => {
    if (event.type === "state.changed" || event.type === "conversation.added") onState()
  })

  // Elapsed-time feedback: refresh the footer while a turn is in flight.
  let wasFlashing = false
  const ticker = setInterval(() => {
    const state = opts.runtime.snapshot()
    const flashing = state.lastTool !== undefined && Date.now() - state.lastTool.at < TOOL_FLASH_MS
    // Also re-render on the tick *after* the flash ends, so the chip settles
    // back to the consistent phase instead of sticking on the last tool.
    if (state.running || flashing || wasFlashing) updateFooter(state)
    wasFlashing = flashing
  }, 250)

  updateFooter(opts.runtime.snapshot())
  renderer.on("resize", () => updateFooter(opts.runtime.snapshot()))
  onState()

  if (opts.notice) print([dim(opts.notice)])
  print([
    bold("stacky"),
    dim("  ·  "),
    plain("REPL mode. Type a task, or "),
    bold("/help"),
    plain(" for commands."),
  ])

  if (opts.initialTask) void submit(opts.initialTask)

  return done
}

function tail(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= length) return flat
  return `…${flat.slice(-(length - 1))}`
}

export function replSupported(): boolean {
  return Boolean(process.stdout.isTTY)
}

/** The footer dashboard: task stack fields, then the file working set. */
function buildDashboard(state: AgentState, width: number, showFiles: boolean, budgetTokens: number): StyledText {
  const labelWidth = 7
  const valueWidth = Math.max(8, width - labelWidth)
  const out: Part[] = []
  let first = true

  const line = (parts: Part[]) => {
    if (!first) out.push(plain("\n"))
    first = false
    out.push(...parts)
  }
  const field = (label: string, value: string) => {
    const wrapped = wrapRaw(value.length > 0 ? value : "—", valueWidth)
    wrapped.forEach((text, index) => {
      line([index === 0 ? dim(label.padEnd(labelWidth)) : plain(" ".repeat(labelWidth)), plain(text)])
    })
  }

  const top = state.stack[state.stack.length - 1]
  if (top) {
    field("TASK", top.title)
    field("WHY", top.why)
    field("SCOPE", top.scope)
    field("DONE", top.definitionOfDone)
    for (const [index, todo] of top.todos.entries()) {
      const glyph = todo.status === "done" ? "✓" : todo.status === "abandoned" ? "✗" : "·"
      field(index === 0 ? "TODO" : "", `${glyph} ${todo.text}${todo.note ? ` — ${todo.note}` : ""}`)
    }
    const parents = state.stack.slice(0, -1)
    if (parents.length > 0) field("STACK", parents.map((frame) => frame.title).join(" › "))
  } else {
    field("TASK", "no active frame")
  }

  if (showFiles) {
    line([dim("─".repeat(width))])
    const used = state.files.reduce((total, file) => total + file.tokenCount, 0)
    const list =
      state.files.length > 0
        ? state.files.map((file) => `${file.path} ${formatTokens(file.tokenCount)}`).join("   ")
        : `no files in context   ·   ${formatTokens(used)} / ${formatTokens(budgetTokens)} tokens`
    field("FILES", list)
  }

  return concat(out)
}

function countLines(styled: StyledText): number {
  if (styled.chunks.length === 0) return 0
  let lines = 1
  for (const chunk of styled.chunks) lines += chunk.text.split("\n").length - 1
  return lines
}

export { fit }
