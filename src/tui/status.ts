import { bg, bold, fg, reverse, type ColorInput } from "@opentui/core"
import type { AgentState } from "../agent/types.ts"
import { theme } from "./theme.ts"
import type { Part } from "./render.ts"

/** How long a finished tool's ✓/✗ result stays attached to the chip. */
export const TOOL_FLASH_MS = 1200

/**
 * A status chip. When `bar`/`text` are set they are applied as an explicit
 * foreground/background pair chosen for contrast (see theme.chip). With no pair
 * the chip inverts the terminal's own fg/bg, which always contrasts.
 */
export type Chip = { label: string; bar?: ColorInput; text?: ColorInput }

/**
 * The chip always reflects the *current* phase — planning, running, thinking,
 * writing, running a tool, or waiting — with elapsed seconds and todo progress
 * where they help. The most recent tool result is appended as a ✓/✗ while it is
 * fresh, so the chip shows a consistent state plus the last outcome rather than
 * only the last outcome.
 */
export function statusChip(state: AgentState, now = Date.now()): Chip {
  const chip = derivePhase(state, now)
  if (!state.activeTool && state.lastTool && now - state.lastTool.at < TOOL_FLASH_MS) {
    chip.label += state.lastTool.ok ? " ✓" : " ✗"
  }
  return chip
}

function derivePhase(state: AgentState, now: number): Chip {
  if (state.activeTool) {
    const chip: Chip = { label: `TOOL ${state.activeTool}`, ...theme.chip.blue }
    if (state.running) appendElapsed(chip, state.phaseStartedAt, now)
    return chip
  }

  if (state.mode === "waiting_for_user") {
    const reason = (state.userRequest?.choices?.length ?? 0) > 0 ? "·choice" : "·reply"
    return { label: `WAIT ${reason}`, ...theme.chip.yellow }
  }

  if (state.streaming?.reasoning) {
    const chip: Chip = { label: "THINK", ...theme.chip.magenta }
    if (state.running) appendElapsed(chip, state.streaming.reasoningStartedAt, now)
    return chip
  }

  if (state.streaming?.text) {
    const chip: Chip = { label: "WRITE", ...theme.chip.blue }
    if (state.running) appendThroughput(chip, state.streaming.text, state.streaming.textStartedAt, now)
    return chip
  }

  if (state.running) {
    const chip: Chip = state.mode === "push" ? { label: "PLAN", ...theme.chip.green } : { label: "RUN", ...theme.chip.green }
    appendTodoProgress(chip, state)
    return chip
  }

  const chip: Chip = state.mode === "push" ? { label: "READY" } : { label: "IDLE" }
  appendTodoProgress(chip, state)
  return chip
}

/** Append `done/total` for the top frame's checklist, when it has one. */
function appendTodoProgress(chip: Chip, state: AgentState): void {
  const frame = state.stack[state.stack.length - 1]
  if (!frame || frame.todos.length === 0) return
  const done = frame.todos.filter((todo) => todo.status !== "pending").length
  chip.label += ` ${done}/${frame.todos.length}`
}

function appendElapsed(chip: Chip, since: number | undefined, now: number): void {
  if (!since) return
  const ms = now - since
  if (ms >= 1000) chip.label += ` ${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function appendThroughput(chip: Chip, text: string, since: number | undefined, now: number): void {
  if (!since) return
  const seconds = (now - since) / 1000
  if (seconds < 0.6) return
  chip.label += ` ${Math.max(0, Math.round(text.length / 4 / seconds))} t/s`
}

export function renderChip(chip: Chip): Part {
  const label = ` ${chip.label} `
  if (chip.bar && chip.text) return bold(bg(chip.bar)(fg(chip.text)(label)))
  return reverse(bold(label))
}
