import { bg, bold, fg, reverse, type ColorInput } from "@opentui/core"
import type { AgentState } from "../agent/types.ts"
import { theme } from "./theme.ts"
import type { Part } from "./render.ts"

/** How long a finished tool's ✓/✗ result stays on the chip. */
export const TOOL_FLASH_MS = 1200

/**
 * A status chip. When `bar`/`text` are set they are applied as an explicit
 * foreground/background pair chosen for contrast (dark text on bright bars,
 * light text on dark bars) — never the terminal's default foreground, which
 * would clash with a coloured bar. With no pair the chip inverts the terminal's
 * own fg/bg, which always contrasts.
 */
export type Chip = { label: string; bar?: ColorInput; text?: ColorInput }

/**
 * Derive the compact status chip from runtime state. The label says what is
 * happening; the colour says how urgent it is. Shows elapsed seconds while a
 * phase runs, tokens/second while generating, why it is waiting, and a brief
 * ✓/✗ flash when a tool finishes.
 */
export function statusChip(state: AgentState, now = Date.now()): Chip {
  if (state.activeTool) {
    const chip: Chip = { label: `TOOL ${state.activeTool}`, bar: theme.blue, text: theme.onDark }
    if (state.running) appendElapsed(chip, state.phaseStartedAt, now)
    return chip
  }

  if (state.lastTool && now - state.lastTool.at < TOOL_FLASH_MS) {
    const { tool, ok } = state.lastTool
    return {
      label: `TOOL ${tool} ${ok ? "✓" : "✗"}`,
      bar: ok ? theme.green : theme.red,
      text: ok ? theme.onBright : theme.onDark,
    }
  }

  if (state.streaming?.reasoning) {
    const chip: Chip = { label: "THINK", bar: theme.magenta, text: theme.onDark }
    if (state.running) appendElapsed(chip, state.streaming.reasoningStartedAt, now)
    return chip
  }

  if (state.streaming?.text) {
    const chip: Chip = { label: "WRITE", bar: theme.blue, text: theme.onDark }
    if (state.running) appendThroughput(chip, state.streaming.text, state.streaming.textStartedAt, now)
    return chip
  }

  if (state.mode === "waiting_for_user") {
    const reason = (state.userRequest?.choices?.length ?? 0) > 0 ? "·choice" : "·reply"
    return { label: `WAIT ${reason}`, bar: theme.yellow, text: theme.onBright }
  }

  if (state.running) {
    return state.mode === "push"
      ? { label: "PLAN", bar: theme.green, text: theme.onBright }
      : { label: "RUN", bar: theme.green, text: theme.onBright }
  }

  return state.mode === "push" ? { label: "READY" } : { label: "IDLE" }
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
  const tokens = text.length / 4
  chip.label += ` ${Math.max(0, Math.round(tokens / seconds))} t/s`
}

export function renderChip(chip: Chip): Part {
  const label = ` ${chip.label} `
  if (chip.bar && chip.text) return bold(bg(chip.bar)(fg(chip.text)(label)))
  return reverse(bold(label))
}
