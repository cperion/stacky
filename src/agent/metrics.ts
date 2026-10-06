import type { Metrics } from "./types.ts"

export type { Metrics }

export function createMetrics(): Metrics {
  return {
    llmCalls: 0,
    toolCalls: 0,
    pushes: 0,
    pops: 0,
    maxStackDepth: 0,
    filesPromoted: 0,
    filesEvicted: 0,
    protocolErrors: 0,
    userRequests: 0,
    outcomes: {
      completed: 0,
      disproven: 0,
      unnecessary: 0,
      abandoned: 0,
      superseded: 0,
      blocked: 0,
      failed: 0,
      partial: 0,
    },
  }
}
