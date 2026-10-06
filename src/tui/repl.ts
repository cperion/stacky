import {
  bold,
  BoxRenderable,
  createCliRenderer,
  dim,
  fg,
  InputRenderable,
  italic,
  reverse,
  StyledText,
  TextRenderable,
} from "@opentui/core"
import type { AgentRuntime } from "../agent/runtime.ts"
import type { AgentState, ConversationEntry, StreamingState } from "../agent/types.ts"
import { applyTheme, theme } from "./theme.ts"
import { block, clampLines, concat, fit, plain, quoteBlock, shadeBlock, wrapRaw, type Part } from "./render.ts"
import type { SettingsController, UiResult } from "./settings.ts"
import { MODEL_CATALOG, PROVIDERS } from "../llm/catalog.ts"

export type ReplOptions = {
  runtime: AgentRuntime
  settings: SettingsController
  initialTask?: string
  notice?: string
}

const FOOTER_HEIGHT = 3

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
    footerHeight: FOOTER_HEIGHT,
    exitOnCtrlC: true,
    targetFps: 30,
    onDestroy: () => resolveDone(result),
  })

  await applyTheme(renderer, opts.settings.config.theme)

  // ---- footer -------------------------------------------------------------

  const footer = new BoxRenderable(renderer, { width: "100%", height: FOOTER_HEIGHT, flexDirection: "column" })
  const status = new TextRenderable(renderer, {
    content: "",
    fg: theme.fg,
    bg: theme.bg,
    wrapMode: "none",
    height: 1,
  })
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
  footer.add(status)
  footer.add(live)
  footer.add(promptRow)
  renderer.root.add(footer)
  input.focus()

  // ---- scrollback output --------------------------------------------------

  const rendererWidth = () => Math.max(20, renderer.width - 1)

  const writeBlock = (content: StyledText, trailingBlank = true): void => {
    // writeToScrollback uses the root's height before layout, so compute it from
    // the content itself (one row per line, plus an optional blank separator).
    const lineCount = content.chunks.reduce((n, chunk) => n + (chunk.text.split("\n").length - 1), 0) + 1
    const height = lineCount + (trailingBlank ? 1 : 0)
    renderer.writeToScrollback((ctx) => {
      const box = new BoxRenderable(ctx.renderContext, {
        width: ctx.width,
        flexDirection: "column",
        backgroundColor: "transparent",
        shouldFill: false,
      })
      box.add(
        new TextRenderable(ctx.renderContext, {
          content,
          fg: theme.fg,
          bg: "transparent",
          wrapMode: "none",
          width: ctx.width,
        }),
      )
      if (trailingBlank) {
        box.add(new TextRenderable(ctx.renderContext, { content: " ", fg: theme.fg, bg: "transparent" }))
      }
      return { root: box, height, startOnNewLine: true, trailingNewline: true }
    })
  }

  const entryParts = (entry: ConversationEntry, width: number, showThinking: boolean): StyledText | undefined => {
    switch (entry.role) {
      case "user":
        return shadeBlock(
          concat([fg(theme.green)("▌ "), bold("You"), plain("\n"), plain(block(entry.text, width, 2))]),
          width,
          theme.shade,
        )
      case "agent":
        return concat([fg(theme.cyan)("▌ "), bold("Agent"), plain("\n"), plain(block(entry.text, width, 2))])
      case "thinking":
        if (!showThinking) return undefined
        return concat([
          fg(theme.magenta)("✻ "),
          bold("Thinking"),
          plain("\n"),
          italic(dim(block(clampLines(entry.text, 40), width, 2, "│"))),
        ])
      case "action":
        return actionParts(entry.text, width)
      case "observation":
        return shadeBlock(quoteBlock(clampLines(entry.text, 16), width, theme.dim), width, theme.shade)
      case "protocol":
        return concat([fg(theme.red)("✗ "), fg(theme.red)(block(entry.text, width, 2))])
    }
  }

  const printedIds = new Set<string>()
  const flushConversation = (state: AgentState): void => {
    for (const entry of state.conversation) {
      if (printedIds.has(entry.id)) continue
      printedIds.add(entry.id)
      const parts = entryParts(entry, rendererWidth(), opts.settings.config.showThinking)
      if (parts) writeBlock(parts)
    }
  }

  const writeLine = (parts: Part[], trailingBlank = false): void => {
    writeBlock(concat(parts), trailingBlank)
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
    const busy = state.streaming?.active === true
    const mode = state.mode === "waiting_for_user" ? "WAITING" : state.mode.toUpperCase()
    const m = state.metrics
    const meta = `${opts.runtime.llmLabel}${opts.settings.config.thinking ? " · thinking" : ""} · llm ${m.llmCalls} · depth ${state.stack.length} · files ${state.files.length}`
    const hint = busy ? "ctrl+c quit · /help" : "ctrl+c quit · /help"
    status.content = concat([reverse(bold(` ${mode} `)), plain("  "), dim(meta), plain("   "), dim(hint)])

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
    const streaming = state.streaming
    if (streaming?.active) return streamingLine(streaming, rendererWidth())
    if (state.mode === "execute") return concat([dim("working…")])
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

  const handleCommand = (text: string): boolean => {
    const [rawCommand, ...rest] = text.slice(1).split(/\s+/)
    const command = (rawCommand ?? "").toLowerCase()
    const argument = rest.join(" ").trim()

    switch (command) {
      case "help":
        print([
          bold("Commands"),
          plain("\n"),
          dim("  /model [id]        show or choose a model"),
          plain("\n"),
          dim("  /thinking [on|off] toggle reasoning mode"),
          plain("\n"),
          dim("  /thinking-blocks   toggle thinking display"),
          plain("\n"),
          dim("  /theme [mode]      auto | dark | light (restart to apply)"),
          plain("\n"),
          dim("  /status            show runtime status"),
          plain("\n"),
          dim("  /new               reset the session"),
          plain("\n"),
          dim("  /ui panes          switch to the panes interface"),
          plain("\n"),
          dim("  /quit              exit"),
        ])
        return true
      case "model": {
        if (!argument) {
          const lines: Part[] = [bold("Models"), plain("\n")]
          for (const provider of PROVIDERS) {
            for (const model of MODEL_CATALOG[provider]) {
              const current = opts.settings.config.provider === provider && opts.settings.config.model === model
              lines.push(plain(`  ${current ? "❯" : " "} ${provider}/${model}`), plain("\n"))
            }
          }
          lines.push(dim("  /model <provider>/<model> to choose"))
          print(lines)
          return true
        }
        const [providerPart, modelPart] = argument.includes("/") ? argument.split("/", 2) : [undefined, argument]
        const provider = (providerPart as (typeof PROVIDERS)[number] | undefined) ?? opts.settings.config.provider
        if (!MODEL_CATALOG[provider]?.includes(modelPart ?? "")) {
          print([fg(theme.red)(`Unknown model "${argument}". Try /model to list.`)])
          return true
        }
        opts.settings.config.provider = provider
        opts.settings.config.model = modelPart!
        opts.settings.rebuildModel()
        opts.settings.persist()
        print([plain("Model: "), bold(`${provider}/${modelPart}`)])
        return true
      }
      case "thinking":
      case "think": {
        const value = argument ? argument === "on" : !opts.settings.config.thinking
        opts.settings.config.thinking = value
        opts.settings.rebuildModel()
        opts.settings.persist()
        print([plain(`Thinking ${value ? "on" : "off"}.`)])
        return true
      }
      case "thinking-blocks":
      case "showthinking": {
        const value = argument ? argument === "on" : !opts.settings.config.showThinking
        opts.settings.config.showThinking = value
        opts.settings.persist()
        print([plain(`Thinking display ${value ? "on" : "off"}.`)])
        return true
      }
      case "theme": {
        const valid = ["auto", "dark", "light"]
        if (!valid.includes(argument)) {
          print([plain(`Theme is ${opts.settings.config.theme}. Usage: /theme auto|dark|light`) ])
          return true
        }
        opts.settings.config.theme = argument as "auto" | "dark" | "light"
        opts.settings.persist()
        print([plain(`Theme set to ${argument}. Restart to apply.`)])
        return true
      }
      case "status": {
        const state = opts.runtime.snapshot()
        print([
          bold("Status"),
          plain("\n"),
          dim(`  ui        repl`),
          plain("\n"),
          dim(`  mode      ${state.mode}`),
          plain("\n"),
          dim(`  model     ${opts.runtime.llmLabel}`),
          plain("\n"),
          dim(`  thinking  ${opts.settings.config.thinking ? "on" : "off"}`),
          plain("\n"),
          dim(`  depth     ${state.stack.length}`),
          plain("\n"),
          dim(`  files     ${state.files.length}`),
          plain("\n"),
          dim(`  llm       ${state.metrics.llmCalls} calls`),
        ])
        return true
      }
      case "new":
      case "clear":
        opts.runtime.reset()
        print([plain("Session reset.")])
        return true
      case "ui":
        if (argument === "panes" || argument === "pane") {
          result = "switch"
          opts.settings.config.ui = "panes"
          opts.settings.persist()
          renderer.destroy()
          return true
        }
        print([dim("Usage: /ui panes")])
        return true
      case "quit":
      case "exit":
        result = "quit"
        renderer.destroy()
        return true
      default:
        print([fg(theme.red)(`Unknown command /${command}. Try /help.`)])
        return true
    }
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
      handleCommand(trimmed)
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
    if (event.type === "state.changed") onState()
  })

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

function actionParts(text: string, width: number): StyledText {
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
  return concat(parts)
}

function tail(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= length) return flat
  return `…${flat.slice(-(length - 1))}`
}

export function replSupported(): boolean {
  return Boolean(process.stdout.isTTY)
}

export { fit }
