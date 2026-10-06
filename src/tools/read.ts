import { readFileSync, statSync } from "node:fs"
import type { ToolResult } from "../agent/types.ts"
import { resolvePath } from "../files/lru.ts"

export type ReadValue = {
  path: string
  content: string
  bytes: number
  truncated: boolean
}

const MAX_READ_CHARS = 200_000

/**
 * Read a file AND promote it into the live working set. The returned content is
 * the current filesystem state; before every inference the runtime re-reads it.
 */
export function runRead(path: string, opts: { cwd: string }): ToolResult<ReadValue> {
  const abs = resolvePath(opts.cwd, path)
  try {
    const stat = statSync(abs)
    if (stat.isDirectory()) {
      return { ok: false, error: `Path is a directory: ${path}` }
    }
    const full = readFileSync(abs, "utf8")
    const truncated = full.length > MAX_READ_CHARS
    const content = truncated ? full.slice(0, MAX_READ_CHARS) : full
    return { ok: true, value: { path, content, bytes: stat.size, truncated } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
