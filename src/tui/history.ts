import { dim, fg, type ColorInput } from "@opentui/core"
import type { AgentState } from "../agent/types.ts"
import { theme } from "./theme.ts"
import { clipText, concat, plain, type Part } from "./render.ts"

const CELL_WIDTH = 22

type Cell = { title: string; status: string; color: ColorInput }

const OUTCOMES: Record<string, { glyph: string; color: ColorInput }> = {
  completed: { glyph: "✓", color: theme.green },
  partial: { glyph: "◐", color: theme.yellow },
  blocked: { glyph: "■", color: theme.red },
  failed: { glyph: "✗", color: theme.red },
  disproven: { glyph: "⊘", color: theme.gray },
  unnecessary: { glyph: "–", color: theme.gray },
  abandoned: { glyph: "⨯", color: theme.gray },
  superseded: { glyph: "↷", color: theme.gray },
}

/**
 * A two-row stripe of *resolved* frames in creation order, each cell showing the
 * frame title and its outcome. The most recent cells are shown; older ones
 * collapse to a `+n` marker. The open stack is the dashboard's job.
 */
export function historyStripe(state: AgentState, width: number): Part[] {
  const cells = collectCells(state)
  if (cells.length === 0) return []

  const perRow = Math.max(1, Math.floor((width + 1) / (CELL_WIDTH + 1)))
  const shown = cells.slice(-perRow)
  const hidden = cells.length - shown.length

  const line1: Part[] = []
  const line2: Part[] = []
  if (hidden > 0) {
    line1.push(dim(`+${hidden} `))
    line2.push(plain(" ".repeat(String(hidden).length + 2)))
  }
  shown.forEach((cell, index) => {
    if (index > 0 || hidden > 0) {
      line1.push(dim("│"))
      line2.push(dim("│"))
    }
    line1.push(plain(clipText(cell.title, CELL_WIDTH).padEnd(CELL_WIDTH)))
    line2.push(fg(cell.color)(`${cell.status}`.padEnd(CELL_WIDTH).slice(0, CELL_WIDTH)))
    line1.push(dim(" "))
    line2.push(plain(" "))
  })

  return [concat(line1), plain("\n"), concat(line2)]
}

/** Only resolved frames: the current (open) stack lives in the dashboard. */
function collectCells(state: AgentState): Cell[] {
  return [...state.closedFrames]
    .sort((a, b) => a.intent.seq - b.intent.seq)
    .map((closed) => {
      const outcome = OUTCOMES[closed.disposition.outcome] ?? { glyph: "·", color: theme.gray }
      return {
        title: closed.intent.title,
        status: `${outcome.glyph} ${closed.disposition.outcome}`,
        color: outcome.color,
      }
    })
}
