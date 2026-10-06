import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ToolResult } from "../agent/types.ts"
import { resolvePath } from "../files/lru.ts"

export type EditOperation = {
  oldText: string
  newText: string
  replaceAll?: boolean
}

export type EditValue = {
  path: string
  created: boolean
  replacements: number
}

/**
 * Modify a file. `oldText: ""` on a missing file creates it.
 * Refuses ambiguous matches unless `replaceAll` is set.
 */
export function runEdit(path: string, edits: EditOperation[], opts: { cwd: string }): ToolResult<EditValue> {
  const abs = resolvePath(opts.cwd, path)
  const existed = existsSync(abs)
  let content = existed ? readFileSync(abs, "utf8") : ""
  let created = false
  let replacements = 0

  for (const [index, edit] of edits.entries()) {
    if (!existed && edit.oldText === "") {
      content = edit.newText
      created = true
      continue
    }

    const count = countOccurrences(content, edit.oldText)
    if (count === 0) {
      return {
        ok: false,
        error: `Edit #${index + 1} for ${path}: oldText was not found. The file may have changed; re-read it and retry.`,
      }
    }
    if (count > 1 && !edit.replaceAll) {
      return {
        ok: false,
        error: `Edit #${index + 1} for ${path}: oldText matches ${count} times. Provide a larger unique context or set replaceAll.`,
      }
    }

    if (edit.replaceAll) {
      content = content.split(edit.oldText).join(edit.newText)
      replacements += count
    } else {
      content = content.replace(edit.oldText, edit.newText)
      replacements += 1
    }
  }

  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, "utf8")
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return { ok: true, value: { path, created, replacements } }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}
