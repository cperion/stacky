import { readFileSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { FileEntry, MaterializedFile } from "../agent/types.ts"
import { estimateTokens } from "../agent/conversation.ts"

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export function relativePath(cwd: string, path: string): string {
  const abs = resolvePath(cwd, path)
  return abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs
}

export type FileWorkingSetOptions = {
  cwd: string
  budgetTokens?: number
  maxFileBytes?: number
}

/**
 * Token-bounded LRU of file paths.
 *
 * The cache stores identity (paths), never snapshots. `materialize()` re-reads
 * every active file from disk, so the model always sees current filesystem
 * state (idea.md §5, implementation.md §10).
 */
export class FileWorkingSet {
  private entries = new Map<string, FileEntry>()
  private clock = 0
  private stableCounter = 0
  readonly cwd: string
  readonly budgetTokens: number
  readonly maxFileBytes: number

  constructor(opts: FileWorkingSetOptions) {
    this.cwd = opts.cwd
    this.budgetTokens = opts.budgetTokens ?? 24_000
    this.maxFileBytes = opts.maxFileBytes ?? 2_000_000
  }

  /** Paths in LRU order, hottest first. */
  list(): FileEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastUsed - a.lastUsed)
  }

  /** Paths in stable first-seen order, used for deterministic prompt serialization. */
  stableOrder(): FileEntry[] {
    return [...this.entries.values()].sort((a, b) => a.stableIndex - b.stableIndex)
  }

  has(path: string): boolean {
    return this.entries.has(relativePath(this.cwd, path))
  }

  totalTokens(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.tokenCount
    return total
  }

  /**
   * Promote a path (read or edit) into the working set and re-read its size
   * from disk. Returns the evicted paths, if any.
   */
  promote(path: string): { entry: FileEntry; evicted: string[] } {
    const rel = relativePath(this.cwd, path)
    const abs = resolvePath(this.cwd, rel)
    const tokenCount = this.sizeOf(abs)
    const existing = this.entries.get(rel)
    this.clock += 1

    const entry: FileEntry = existing
      ? { ...existing, lastUsed: this.clock, tokenCount }
      : { path: rel, lastUsed: this.clock, tokenCount, stableIndex: this.stableCounter++ }

    this.entries.set(rel, entry)
    const evicted = this.evict(rel)
    return { entry, evicted }
  }

  remove(path: string): boolean {
    return this.entries.delete(relativePath(this.cwd, path))
  }

  clear(): void {
    this.entries.clear()
  }

  restore(paths: string[]): void {
    this.entries.clear()
    for (const p of paths) this.promote(p)
  }

  /**
   * Re-read every active file from disk, in stable order.
   * Missing files are reported but not silently dropped.
   */
  materialize(): MaterializedFile[] {
    const out: MaterializedFile[] = []
    for (const entry of this.stableOrder()) {
      const abs = resolvePath(this.cwd, entry.path)
      try {
        const content = readFileSync(abs, "utf8")
        out.push({ path: entry.path, content, tokens: estimateTokens(content), missing: false })
      } catch {
        out.push({ path: entry.path, content: "", tokens: 0, missing: true })
      }
    }
    return out
  }

  private sizeOf(abs: string): number {
    try {
      const stat = statSync(abs)
      if (!stat.isFile()) return 0
      const content = readFileSync(abs, "utf8")
      return estimateTokens(content.slice(0, this.maxFileBytes))
    } catch {
      return 0
    }
  }

  /** Evict least-recently-used entries until the budget fits. */
  private evict(justPromoted: string): string[] {
    const evicted: string[] = []
    while (this.totalTokens() > this.budgetTokens) {
      const victims = [...this.entries.values()]
        .filter((e) => e.path !== justPromoted)
        .sort((a, b) => a.lastUsed - b.lastUsed)
      const victim = victims[0]
      if (!victim) break
      this.entries.delete(victim.path)
      evicted.push(victim.path)
    }
    return evicted
  }
}
