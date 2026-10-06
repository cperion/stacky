import { bg, bold, fg, reverse, type ColorInput } from "@opentui/core"
import type { AgentState } from "../agent/types.ts"
import { theme } from "./theme.ts"
import type { Part } from "./render.ts"

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
 * happening; the colour says how urgent it is.
 */
export function statusChip(state: AgentState, now = Date.now()): Chip {
  const chip = deriveChip(state)
  if (state.running && state.phaseStartedAt) {
    const ms = now - state.phaseStartedAt
    if (ms >= 1000) chip.label = `${chip.label} ${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  }
  return chip
}

function deriveChip(state: AgentState): Chip {
  // Bright bars take dark text; dark bars take light text.
  if (state.mode === "waiting_for_user") return { label: "WAIT", bar: theme.yellow, text: theme.onBright }
  if (state.streaming?.reasoning) return { label: "THINK", bar: theme.magenta, text: theme.onDark }
  if (state.streaming?.text) return { label: "WRITE", bar: theme.blue, text: theme.onDark }
  const tool = state.activeTool ?? state.streaming?.tool
  if (tool) return { label: `TOOL ${tool}`, bar: theme.blue, text: theme.onDark }
  if (state.running) {
    return state.mode === "push"
      ? { label: "PLAN", bar: theme.green, text: theme.onBright }
      : { label: "RUN", bar: theme.green, text: theme.onBright }
  }
  if (state.mode === "push") return { label: "READY" }
  return { label: "IDLE" }
}

export function renderChip(chip: Chip): Part {
  const label = ` ${chip.label} `
  if (chip.bar && chip.text) return bold(bg(chip.bar)(fg(chip.text)(label)))
  return reverse(bold(label))
}
