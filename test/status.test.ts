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
  test("waiting for the user", () => {
    expect(statusChip(state({ mode: "waiting_for_user" })).label).toBe("WAIT")
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

  test("the waiting chip is coloured", () => {
    expect(statusChip(state({ mode: "waiting_for_user" })).color).toBeDefined()
  })
})
