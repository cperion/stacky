import { describe, expect, test } from "bun:test"
import type { AgentState } from "../src/agent/types.ts"
import { createMetrics } from "../src/agent/metrics.ts"
import { statusChip } from "../src/tui/status.ts"

function state(overrides: Partial<AgentState>): AgentState {
  return {
    mode: "execute",
    running: false,
    conversation: [],
    stack: [],
    closedFrames: [],
    files: [],
    metrics: createMetrics(),
    ...overrides,
  }
}

describe("statusChip", () => {
  test("waiting states say why", () => {
    expect(statusChip(state({ mode: "waiting_for_user" })).label).toBe("WAIT ·reply")
    expect(
      statusChip(
        state({
          mode: "waiting_for_user",
          userRequest: { id: "1", at: 0, resolved: false, message: "?", response: "required", choices: [{ id: "a", label: "A" }] },
        }),
      ).label,
    ).toBe("WAIT ·choice")
  })

  test("flashes the last tool result briefly", () => {
    const ok = statusChip(state({ lastTool: { tool: "bash", ok: true, at: 1000 } }), 1500)
    expect(ok.label).toBe("TOOL bash ✓")
    const bad = statusChip(state({ lastTool: { tool: "bash", ok: false, at: 1000 } }), 1500)
    expect(bad.label).toBe("TOOL bash ✗")
    // Expired: back to the normal phase.
    expect(statusChip(state({ lastTool: { tool: "bash", ok: true, at: 1000 } }), 9000).label).toBe("IDLE")
  })

  test("shows tokens per second while writing", () => {
    const writing = state({
      running: true,
      streaming: { active: true, reasoning: "", text: "x".repeat(400), startedAt: 0, textStartedAt: 2000 },
    })
    // 400 chars ~= 100 tokens over 2s.
    expect(statusChip(writing, 4000).label).toBe("WRITE 50 t/s")
  })

  test("streaming reasoning vs text", () => {
    const reasoning = state({ running: true, streaming: { active: true, reasoning: "…", text: "", startedAt: 0 } })
    expect(statusChip(reasoning).label).toBe("THINK")
    const text = state({ running: true, streaming: { active: true, reasoning: "", text: "…", startedAt: 0 } })
    expect(statusChip(text).label).toBe("WRITE")
  })

  test("active tool wins over the running phase", () => {
    expect(statusChip(state({ running: true, activeTool: "bash" })).label).toBe("TOOL bash")
  })

  test("planning vs executing vs idle", () => {
    expect(statusChip(state({ mode: "push", running: true })).label).toBe("PLAN")
    expect(statusChip(state({ mode: "execute", running: true })).label).toBe("RUN")
    expect(statusChip(state({ mode: "push", running: false })).label).toBe("READY")
    expect(statusChip(state({ mode: "execute", running: false })).label).toBe("IDLE")
  })

  test("coloured chips carry a contrasting fg/bg pair", () => {
    const wait = statusChip(state({ mode: "waiting_for_user" }))
    expect(wait.bar).toBeDefined()
    expect(wait.text).toBeDefined()
    const ready = statusChip(state({ mode: "push", running: false }))
    expect(ready.bar).toBeUndefined()
  })

  test("shows elapsed time while a phase is running", () => {
    const running = state({ running: true, activeTool: "bash", phaseStartedAt: 1000 })
    expect(statusChip(running, 3500).label).toBe("TOOL bash 2.5s")
    // No elapsed suffix once the phase is over.
    expect(statusChip(state({ activeTool: "bash", phaseStartedAt: 1000 }), 3500).label).toBe("TOOL bash")
  })
})
