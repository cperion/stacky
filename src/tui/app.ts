import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core"
import type { AgentRuntime } from "../agent/runtime.ts"
import type { AgentState } from "../agent/types.ts"
import { TaskPane } from "./task-pane.ts"
import { ChatPane } from "./chat-pane.ts"
import { FilePane } from "./file-pane.ts"
import { theme } from "./theme.ts"

export type AppOptions = {
  runtime: AgentRuntime
  fileBudgetTokens: number
  providerLabel: string
  initialTask?: string
  notice?: string
}

export async function runApp(opts: AppOptions): Promise<void> {
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    onDestroy: () => resolveDone(),
  })

  const outer = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
  })
  const main = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
  })

  const taskPane = new TaskPane(renderer, { width: "26%" })
  let selectedChoice = 0
  const chatPane = new ChatPane(renderer, {
    onSubmit: (text) => handleSubmit(text),
  })
  const filePane = new FilePane(renderer, { width: "26%", budgetTokens: opts.fileBudgetTokens })

  const footer = new TextRenderable(renderer, { content: "", fg: theme.fg, wrapMode: "none" })

  main.add(taskPane.box)
  main.add(chatPane.box)
  main.add(filePane.box)
  outer.add(main)
  outer.add(footer)
  renderer.root.add(outer)

  let showHistory = false

  const render = () => {
    const state = opts.runtime.snapshot()
    taskPane.update(state, showHistory)
    chatPane.update(state, selectedChoice)
    filePane.update(state)
    footer.content = renderFooter(state, opts.providerLabel, showHistory, opts.notice)
  }

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
      opts.runtime.bus.emit({ type: "fatal", message })
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

  renderer.keyInput.on("keypress", (key) => {
    const snapshot = opts.runtime.snapshot()
    const choiceActive =
      snapshot.mode === "waiting_for_user" && (snapshot.userRequest?.choices?.length ?? 0) > 0

    // Arrows only mean something while a choice prompt is on screen. Otherwise
    // they belong to the chat input.
    if (choiceActive && key.name === "up") {
      moveChoice(-1)
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (choiceActive && key.name === "down") {
      moveChoice(1)
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
    }
  })

  opts.runtime.bus.on((event) => {
    if (event.type === "state.changed") render()
    else if (event.type === "user.request") {
      selectedChoice = preferredIndex()
      render()
    } else if (
      event.type === "frame.pushed" ||
      event.type === "frame.popped" ||
      event.type === "file.promoted" ||
      event.type === "file.evicted"
    ) {
      render()
    }
  })

  render()
  chatPane.focus()

  if (opts.initialTask) {
    void submit(opts.initialTask)
  }

  await done
}

function renderFooter(
  state: AgentState,
  providerLabel: string,
  showHistory: boolean,
  notice: string | undefined,
): string {
  if (notice && state.conversation.length === 0) return ` ${notice}`

  const hint =
    state.mode === "waiting_for_user"
      ? "waiting for you · ↑/↓ choose · Enter select · or type a reply"
      : state.mode === "push"
        ? "type a task · ctrl+t history · ctrl+c quit"
        : "working… · ctrl+c quit"
  const m = state.metrics
  const stats = `llm ${m.llmCalls} · tools ${m.toolCalls} · files ${state.files.length} · depth ${state.stack.length}`
  return ` ${state.mode.toUpperCase()} · ${providerLabel} · ${stats} · ${hint}${showHistory ? " · history shown" : ""}`
}
