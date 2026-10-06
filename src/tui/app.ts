import { bold, BoxRenderable, createCliRenderer, dim, reverse, TextRenderable } from "@opentui/core"
import type { AgentRuntime } from "../agent/runtime.ts"
import type { AgentState } from "../agent/types.ts"
import { TaskPane } from "./task-pane.ts"
import { ChatPane } from "./chat-pane.ts"
import { FilePane } from "./file-pane.ts"
import { MenuOverlay } from "./menu.ts"
import { buildSettingsMenu, type MenuContext } from "./menus.ts"
import { theme } from "./theme.ts"
import { concat, plain } from "./render.ts"
import type { SettingsController, UiResult } from "./settings.ts"

export type AppOptions = {
  runtime: AgentRuntime
  settings: SettingsController
  initialTask?: string
  notice?: string
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const RENDER_INTERVAL_MS = 33
const SPINNER_INTERVAL_MS = 90

export async function runApp(opts: AppOptions): Promise<UiResult> {
  let result: UiResult = "quit"
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    onDestroy: () => {
      clearInterval(spinnerTimer)
      resolveDone()
    },
  })

  const outer = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" })
  const main = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    flexDirection: "row",
    gap: 1,
  })

  const taskPane = new TaskPane(renderer, { width: "26%" })
  let selectedChoice = 0
  const chatPane = new ChatPane(renderer, { onSubmit: (text) => handleSubmit(text) })
  const filePane = new FilePane(renderer, { width: "26%" })
  const footer = new TextRenderable(renderer, {
    content: "",
    fg: theme.fg,
    bg: theme.bg,
    wrapMode: "none",
    height: 1,
  })
  const menu = new MenuOverlay(renderer)

  main.add(taskPane.box)
  main.add(chatPane.box)
  main.add(filePane.box)
  outer.add(main)
  outer.add(footer)
  outer.add(menu.box)
  renderer.root.add(outer)

  let showHistory = false
  let spin = 0

  // --- rendering -------------------------------------------------------------

  const render = () => {
    const state = opts.runtime.snapshot()
    taskPane.update(state, showHistory)
    chatPane.update(state, selectedChoice, opts.settings.config.showThinking)
    filePane.update(state, opts.settings.config.fileBudgetTokens)

    // The border reflects what the agent needs from you.
    const busy = state.streaming?.active === true
    chatPane.box.borderColor =
      state.mode === "waiting_for_user" ? theme.yellow : busy ? theme.blue : theme.dim

    const line = buildFooter(state, {
      label: opts.runtime.llmLabel,
      thinking: opts.settings.config.thinking,
      showHistory,
      notice: opts.notice,
      spinner: SPINNER[spin % SPINNER.length] ?? "…",
    })
    footer.content = line
  }

  let renderPending = false
  const requestRender = () => {
    if (renderPending) return
    renderPending = true
    setTimeout(() => {
      renderPending = false
      render()
    }, RENDER_INTERVAL_MS)
  }

  const spinnerTimer = setInterval(() => {
    const state = opts.runtime.snapshot()
    if (state.streaming?.active || state.mode === "execute") {
      spin += 1
      requestRender()
    }
  }, SPINNER_INTERVAL_MS)

  // --- menu ------------------------------------------------------------------

  const menuContext: MenuContext = {
    ...opts.settings,
    close: () => setMenuOpen(false),
    resetSession: () => {
      opts.runtime.reset()
      selectedChoice = 0
    },
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

  function setMenuOpen(open: boolean): void {
    if (open) {
      menu.open("Settings", buildSettingsMenu(menuContext))
      chatPane.input.blur()
    } else {
      menu.close()
      chatPane.focus()
    }
    render()
  }

  // --- input -----------------------------------------------------------------

  const preferredIndex = (): number => {
    const request = opts.runtime.snapshot().userRequest
    if (!request?.choices?.length) return 0
    const preferred = request.preferredChoice?.id
    const index = request.choices.findIndex((choice) => choice.id === preferred)
    return index >= 0 ? index : 0
  }

  const moveChoice = (delta: number) => {
    const choices = opts.runtime.snapshot().userRequest?.choices
    if (!choices || choices.length === 0) return
    selectedChoice = (selectedChoice + delta + choices.length) % choices.length
    render()
  }

  async function submit(text: string): Promise<void> {
    try {
      await opts.runtime.request(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      opts.runtime.notify(message)
    }
    render()
  }

  function handleSubmit(text: string) {
    const state = opts.runtime.snapshot()
    const pending = state.userRequest
    const waiting = state.mode === "waiting_for_user" && pending?.response === "required"

    if (waiting && pending?.choices && pending.choices.length > 0) {
      const trimmed = text.trim()
      if (trimmed === "") {
        const choice = pending.choices[selectedChoice] ?? pending.choices[0]
        if (choice) return void submit(choice.label)
      }
      const numeric = Number(trimmed)
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= pending.choices.length) {
        return void submit(pending.choices[numeric - 1]!.label)
      }
    }

    if (!text.trim()) return
    void submit(text)
  }

  renderer.keyInput.on("keypress", async (key) => {
    // While the menu is open it owns the keyboard. Vim motions apply here.
    if (menu.isOpen) {
      key.preventDefault()
      key.stopPropagation()
      const name = key.name
      const activate = name === "l" || name === "return" || name === "enter" || name === "kpenter" || name === "linefeed" || name === "right"
      const backward = name === "h" || name === "left"

      if (name === "escape" || (key.ctrl && name === "p")) {
        setMenuOpen(false)
        return
      }
      if (name === "j" || name === "down") {
        menu.move(1)
        return
      }
      if (name === "k" || name === "up") {
        menu.move(-1)
        return
      }
      if (name === "g" && key.shift) {
        menu.toBottom()
        return
      }
      if (name === "g") {
        menu.toTop()
        return
      }
      if (activate) {
        await menu.activate()
        if (!menu.isOpen) chatPane.focus()
        render()
        return
      }
      if (backward) {
        menu.back()
        if (!menu.isOpen) chatPane.focus()
        render()
        return
      }
      return
    }

    const snapshot = opts.runtime.snapshot()
    const choiceActive = snapshot.mode === "waiting_for_user" && (snapshot.userRequest?.choices?.length ?? 0) > 0
    const inputEmpty = chatPane.input.value.length === 0

    // Vim motions drive the choice list while the chat input is empty; once the
    // user starts typing, characters belong to the input (freeform replies).
    if (choiceActive && inputEmpty) {
      if (key.name === "j" || key.name === "down") {
        moveChoice(1)
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (key.name === "k" || key.name === "up") {
        moveChoice(-1)
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (key.name === "l") {
        handleSubmit("")
        key.preventDefault()
        key.stopPropagation()
        return
      }
    }

    if (key.ctrl && key.name === "p") {
      setMenuOpen(true)
      key.preventDefault()
      key.stopPropagation()
      return
    }

    // Ctrl+T toggles frame history. A bare "h" would be swallowed while typing.
    if (key.ctrl && key.name === "t") {
      showHistory = !showHistory
      key.preventDefault()
      key.stopPropagation()
      render()
      return
    }

    // Escape clears a half-typed message (there is no other modal open).
    if (key.name === "escape" && chatPane.input.value.length > 0) {
      chatPane.input.value = ""
      key.preventDefault()
      key.stopPropagation()
      render()
    }
  })

  opts.runtime.bus.on((event) => {
    if (event.type === "user.request") {
      selectedChoice = preferredIndex()
      requestRender()
      return
    }
    requestRender()
  })

  renderer.on("resize", () => {
    menu.relayout()
    requestRender()
  })

  render()
  chatPane.focus()

  // Box widths are only known after the first layout pass; re-render once so
  // text wrapping uses the real pane widths instead of the fraction fallback.
  setTimeout(() => render(), 60)

  if (opts.initialTask) {
    void submit(opts.initialTask)
  }

  await done
  return result
}

function buildFooter(
  state: AgentState,
  opts: {
    label: string
    thinking: boolean
    showHistory: boolean
    notice: string | undefined
    spinner: string
  },
): ReturnType<typeof concat> {
  if (opts.notice && state.conversation.length === 0) return concat([dim(` ${opts.notice}`)])

  const busy = state.streaming?.active === true
  const mode = state.mode === "waiting_for_user" ? "WAITING" : state.mode.toUpperCase()
  const m = state.metrics
  const meta = `${opts.label}${opts.thinking ? " · thinking" : ""} · llm ${m.llmCalls} · tools ${m.toolCalls} · depth ${state.stack.length}`
  const status = busy ? `${opts.spinner} thinking…` : statusHint(state)

  return concat([
    reverse(bold(` ${mode} `)),
    plain("  "),
    dim(meta),
    plain("   "),
    plain(status),
    opts.showHistory ? dim("  · history") : plain(""),
  ])
}

function statusHint(state: AgentState): string {
  switch (state.mode) {
    case "waiting_for_user":
      return "waiting for you · j/k choose · l/Enter select"
    case "push":
      return "type a task · Ctrl+P settings · Ctrl+T history · Ctrl+C quit"
    default:
      return "working… · Ctrl+C quit"
  }
}
