import { randomUUID } from "node:crypto"
import type { ConversationEntry, ConversationRole } from "../agent/types.ts"

/** Rough token estimate: ~4 characters per token, minimum 1. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Bounded raw conversation history. No summarization, no synthetic memories.
 * When the token budget is exceeded, the oldest entries are evicted (FIFO).
 */
export class ConversationBuffer {
  private items: ConversationEntry[] = []

  constructor(private budgetTokens = 50_000) {}

  get budget(): number { return this.budgetTokens }

  setBudget(tokens: number): void {
    this.budgetTokens = tokens
    this.evict()
  }

  get length(): number {
    return this.items.length
  }

  entries(): readonly ConversationEntry[] {
    return this.items
  }

  tokens(): number {
    let total = 0
    for (const item of this.items) total += item.tokens
    return total
  }

  add(
    role: ConversationRole,
    text: string,
    meta?: { tool?: string; depth?: number; subrole?: ConversationRole; frameId?: string; eventRef?: string; outputRef?: string; source?: "control" | "steering"; modelVisible?: boolean },
    now = Date.now(),
  ): ConversationEntry {
    const entry: ConversationEntry = {
      id: randomUUID(),
      at: now,
      role,
      text,
      tokens: estimateTokens(text),
      ...(meta?.tool ? { tool: meta.tool } : {}),
      ...(meta?.depth !== undefined ? { depth: meta.depth } : {}),
      ...(meta?.subrole ? { subrole: meta.subrole } : {}),
      ...(meta?.frameId ? { frameId: meta.frameId } : {}),
      ...(meta?.eventRef ? { eventRef: meta.eventRef } : {}),
      ...(meta?.outputRef ? { outputRef: meta.outputRef } : {}),
      ...(meta?.source ? { source: meta.source } : {}),
      ...(meta?.modelVisible === false ? { modelVisible: false } : {}),
    }
    this.items.push(entry)
    this.evict()
    return entry
  }

  update(id: string, text: string): void {
    const entry = this.items.find((i) => i.id === id)
    if (!entry) return
    entry.text = text
    entry.tokens = estimateTokens(text)
    this.evict()
  }

  clear(): void {
    this.items = []
  }

  restore(items: ConversationEntry[]): void {
    this.items = [...items]
    this.evict()
  }

  /** Drop oldest entries until the buffer fits, always keeping the newest entry. */
  private evict(): void {
    while (this.tokens() > this.budgetTokens && this.items.length > 1) {
      this.items.shift()
    }
    const last = this.items[0]
    if (last && last.tokens > this.budgetTokens) {
      const limit = Math.max(0, Math.floor(this.budgetTokens) * 4)
      const suffix = last.eventRef ? `\n[abridged; read({ref:"${last.eventRef}"})]` : "\n[abridged]"
      last.text = (last.text.slice(0, Math.max(0, limit - suffix.length)) + suffix).slice(0, limit)
      last.tokens = estimateTokens(last.text)
    }
  }
}
