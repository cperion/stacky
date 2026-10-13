import {
  bold,
  BoxRenderable,
  createCliRenderer,
  dim,
  fg,
  StyledText,
  TextRenderable,
} from "@opentui/core"
import type { AgentRuntime } from "../agent/runtime.ts"
import type { AgentState, ConversationEntry, StreamingState } from "../agent/types.ts"
import { applyTheme, theme, watchChipColors } from "./theme.ts"
import { block, clipText, concat, fit, formatTokens, plain, prefixLines, type Part } from "./render.ts"
import { renderMarkdown } from "./markdown.ts"
import { renderToolCall } from "./action.ts"
import { renderStatusLine, TOOL_FLASH_MS } from "./status.ts"
import { historyStripe } from "./history.ts"
import { Composer } from "./composer.ts"
import { OutputBlocks, OutputViewer, outputPreview } from "./output.ts"
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
  const composer = new Composer(renderer, {
    provider: () => opts.settings.config.provider,
    onSubmit: (value) => { void submit(value) },
    canSubmit: (text) => text.trim().startsWith("/") || !opts.runtime.isRunning || opts.runtime.snapshot().mode === "waiting_for_user",
    onHeightChange: () => updateFooter(opts.runtime.snapshot()),
  })
  const input = composer.input
  footer.add(historyLine)
  footer.add(dashboard)
  footer.add(live)
  footer.add(composer.box)
  footer.add(status)
  renderer.root.add(footer)
  const outputs = new OutputBlocks((ref) => opts.runtime.inspectOutput(ref))
  const outputViewer = new OutputViewer(renderer, outputs, (open) => {
    if (open) {
      input.blur()
      renderer.footerHeight = Math.max(1, renderer.terminalHeight - 1)
    } else {
      footerRows = -1
      input.focus()
      updateFooter(opts.runtime.snapshot())
    }
  })
  renderer.root.add(outputViewer.box)
  input.focus()

  // ---- scrollback output --------------------------------------------------

  const rendererWidth = () => Math.max(20, renderer.width - 1)

  const writeBlock = (content: StyledText, shaded: boolean, trailingBlank = true): void => {
    if (renderer.isDestroyed) return
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
        return plain(outputs.compact(entry, width))
      case "action":
        return renderToolCall(entry, width)
      case "observation":
        return plain(outputs.compact(entry, width))
      case "protocol":
        return concat([fg(theme.red)("✗ "), fg(theme.red)(block(entry.text, width, 2))])
      case "note":
        return concat([dim(block(entry.text, width, 0))])
      case "subagent": {
        const marker = `${"│ ".repeat(Math.max(0, (entry.depth ?? 1) - 1))}⤷ `
        const inner = entry.subrole ?? "observation"
        if (inner === "thinking" && !showThinking) return undefined
        if (inner === "action") return concat([dim(marker), renderToolCall({ text: entry.text, ...(entry.tool ? { tool: entry.tool } : {}) }, width)])
        if (inner === "agent") return concat([dim(marker), plain(block(entry.text, width - marker.length, 0))])
        if (inner === "observation" || inner === "thinking") return prefixLines(plain(outputs.compact(entry, width - marker.length)), marker, theme.dim)
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
    if (renderer.isDestroyed) return
    outputs.sync(state, opts.settings.config.showThinking)
    if (outputViewer.isOpen) {
      const height = Math.max(1, renderer.terminalHeight - 1)
      if (renderer.footerHeight !== height) renderer.footerHeight = height
      outputViewer.refresh()
      return
    }
    status.content = renderStatusLine(state, opts.runtime.llmLabel, rendererWidth(), opts.settings.config.thinking, "Ctrl+O expand · /help")
    live.content = liveContent(state)
    const liveRows = countLines(live.content)
    const available = Math.max(0, renderer.terminalHeight - composer.height - liveRows - 6)
    const pane = buildDashboard(
      state,
      rendererWidth(),
      opts.settings.config.replDashboard,
      opts.settings.config.fileBudgetTokens,
      Math.min(available, Math.floor(renderer.terminalHeight / 3)),
    )
    dashboard.content = pane
    const rows = countLines(pane)
    dashboard.height = rows

    const stripe = renderer.terminalHeight >= 24 && composer.height <= 3 ? historyStripe(state, rendererWidth()) : []
    historyLine.content = concat(stripe)
    const stripeRows = stripe.length > 0 ? 2 : 0
    historyLine.height = stripeRows

    // Only touch the split-footer size when it actually changes — resizing it on
    // every tick disturbs the scroll region.
    live.height = liveRows
    const total = stripeRows + rows + liveRows + composer.height + 1
    if (total !== footerRows) {
      footerRows = total
      footer.height = total
      renderer.footerHeight = total
    }
  }

  const liveContent = (state: AgentState): StyledText => {
    const room = renderer.terminalHeight - composer.height - 2
    if (room < 1) return plain("")
    if (room < 3 && state.running) return plain(state.streaming?.reasoning && opts.settings.config.showThinking ? "✻ Thinking · Ctrl+O" : "→ Working · Ctrl+O")
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
      return plain(`→ Live output · Ctrl+O expand\n${outputPreview(state.toolOutput, rendererWidth(), livePreviewRows(), true)}`)
    }
    const streaming = state.streaming
    if (streaming?.active) return streamingLine(streaming, rendererWidth())
    return plain("")
  }

  const streamingLine = (streaming: StreamingState, width: number): StyledText => {
    if (streaming.text) return plain(tail(streaming.text, width - 2))
    if (streaming.reasoning && opts.settings.config.showThinking) {
      return concat([fg(theme.magenta)("✻ Thinking · Ctrl+O expand\n"), plain(outputPreview(streaming.reasoning, width, livePreviewRows(), true))])
    }
    if (streaming.tool) return concat([fg(theme.blue)("→ "), bold(fg(theme.blue)(streaming.tool)), dim(" running…")])
    return concat([dim("…")])
  }

  const livePreviewRows = () => Math.max(1, Math.min(4, renderer.terminalHeight - composer.height - 4))

  // ---- commands -----------------------------------------------------------

  const print = (parts: Part[]): void => writeLine(parts, true)

  const commandContext: CommandContext = {
    runtime: opts.runtime,
    settings: opts.settings,
    expandOutput: (target) => outputViewer.open(target),
    compactOutput: () => outputViewer.close(),
    print: (text) => print([plain(block(text, rendererWidth(), 0))]),
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
      runCommand(trimmed, commandContext)
      updateFooter(opts.runtime.snapshot())
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

    try {
      await opts.runtime.request(text)
    } catch (error) {
      print([fg(theme.red)(error instanceof Error ? error.message : String(error))])
    }
  }

  renderer.keyInput.on("keypress", (key) => {
    if (outputViewer.isOpen && key.name === "escape" && opts.runtime.isRunning) opts.runtime.interrupt()
    if (outputViewer.handleKey(key)) return
    if (key.ctrl && key.name === "o") {
      key.preventDefault(); key.stopPropagation()
      try { outputViewer.toggle() } catch (error) { print([plain(error instanceof Error ? error.message : String(error))]) }
      return
    }
    if (key.ctrl && key.name === "p") {
      key.preventDefault()
      key.stopPropagation()
      composer.openCommands()
      return
    }
    // Esc always stops active work; otherwise it dismisses completion, preserving the draft.
    if (key.name === "escape" && opts.runtime.isRunning) {
      key.preventDefault()
      key.stopPropagation()
      opts.runtime.interrupt()
      return
    }
    if (input.plainText.length > 0 && composer.handleKey(key)) return
    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      // An idle Escape never destroys an unfinished message.
      return
    }

    const state = opts.runtime.snapshot()
    const choiceActive = state.mode === "waiting_for_user" && (state.userRequest?.choices?.length ?? 0) > 0
    const inputEmpty = input.plainText.length === 0

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

    if (inputEmpty) composer.handleKey(key)
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
    outputs.sync(state, opts.settings.config.showThinking)
    flushConversation(state)
    updateFooter(state)
  }

  const unsubscribe = opts.runtime.bus.on((event) => {
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

  const stopChipColors = watchChipColors(renderer, opts.settings.config.theme, () => updateFooter(opts.runtime.snapshot()))
  updateFooter(opts.runtime.snapshot())
  renderer.on("resize", () => { composer.refresh(); updateFooter(opts.runtime.snapshot()) })
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

  await done
  stopChipColors()
  unsubscribe()
  composer.dispose()
  return result
}

function tail(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= length) return flat
  return `…${flat.slice(-(length - 1))}`
}

export function replSupported(): boolean {
  return Boolean(process.stdout.isTTY)
}

/** Bounded working summary; /task owns the full plan, /status the counters. */
export function buildDashboard(state: AgentState, width: number, visible: boolean, budgetTokens: number, maxRows = 8): StyledText {
  if (!visible || maxRows < 1) return plain("")
  const rows: Part[][] = []
  const field = (label: string, value: string) => rows.push([
    dim(label.padEnd(8)), plain(clipText(value.replace(/\s+/g, " "), Math.max(1, width - 8))),
  ])
  const top = state.stack.at(-1)
  if (top) {
    field("TASK", top.title)
    const pending = top.todos.filter((todo) => todo.status === "pending")
    for (const todo of pending) field("·", todo.text)
    if (pending.length === 0) field("✓", "Checklist resolved")
    if (state.stack.length > 1) field("STACK", state.stack.slice(0, -1).map((frame) => frame.title).join(" › "))
  }
  if (state.files.length > 0 || (state.memory?.views ?? 0) > 0) {
    const used = state.memory?.usedTokens ?? state.files.reduce((total, file) => total + file.tokenCount, 0)
    field("CONTEXT", `${state.memory?.views ?? state.files.length} views · ${formatTokens(used)} / ${formatTokens(budgetTokens)} tokens${state.files.length ? ` · ${state.files.map((file) => file.path).join(" · ")}` : " · /context to inspect"}`)
  }
  const hidden = rows.length > maxRows
  const shown = rows.slice(0, hidden ? Math.max(0, maxRows - 1) : maxRows)
  if (hidden) shown.push([dim(clipText(`… ${rows.length - shown.length} more · /task for the full plan`, width))])
  return concat(shown.flatMap((row, index) => index ? [plain("\n"), ...row] : row))
}

function countLines(styled: StyledText): number {
  if (!styled.chunks.some((chunk) => chunk.text.length > 0)) return 0
  let lines = 1
  for (const chunk of styled.chunks) lines += chunk.text.split("\n").length - 1
  return lines
}

export { fit }
