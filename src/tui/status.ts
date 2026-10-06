import { bg, bold, reverse, type ColorInput } from "@opentui/core"
import type { AgentState } from "../agent/types.ts"
import { theme } from "./theme.ts"
import type { Part } from "./render.ts"

export type Chip = { label: string; color?: ColorInput }

/**
 * Derive the compact status chip from runtime state. The label says what is
 * happening; the colour (a contrast-safe ANSI index bar) says how urgent it is.
 */
export function statusChip(state: AgentState): Chip {
  if (state.mode === "waiting_for_user") return { label: "WAIT", color: theme.yellow }
  if (state.streaming?.reasoning) return { label: "THINK", color: theme.magenta }
  if (state.streaming?.text) return { label: "WRITE", color: theme.blue }
  const tool = state.activeTool ?? state.streaming?.tool
  if (tool) return { label: `TOOL ${tool}`, color: theme.blue }
  if (state.running) return { label: state.mode === "push" ? "PLAN" : "RUN", color: theme.green }
  if (state.mode === "push") return { label: "READY" }
  return { label: "IDLE" }
}

/**
 * Render the chip: a reverse-video token. With a colour it becomes a coloured
 * bar (`reverse(bg(color))`), which the terminal renders with the default
 * foreground text.
 */
export function renderChip(chip: Chip): Part {
  const label = ` ${chip.label} `
  return chip.color ? reverse(bold(bg(chip.color)(label))) : reverse(bold(label))
}
