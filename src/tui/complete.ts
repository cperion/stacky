import { COMMAND_NAMES } from "./commands.ts"

export type Completion = { text: string; cursor: number }

/**
 * Tab completion for the REPL prompt. Completes slash-command names and, after
 * `/model `, model ids. Completes to the longest common prefix; a single match
 * also gets a trailing space so you can keep typing.
 */
export function completeInput(line: string, cursor: number, models: readonly string[]): Completion | undefined {
  const before = line.slice(0, cursor)
  const after = line.slice(cursor)

  // `/mode` -> `/model `
  const command = /^(\/[\w-]*)$/.exec(before)
  if (command) {
    const candidates = COMMAND_NAMES.map((name) => `/${name}`).filter((name) => name.startsWith(command[1]!))
    const filled = resolve(command[1]!, candidates)
    if (!filled) return undefined
    const suffix = filled !== command[1] && candidates.length === 1 ? " " : ""
    return { text: filled + suffix + after, cursor: filled.length + suffix.length }
  }

  // `/model deep` -> `/model deepseek-flash `
  const model = /^(\/model\s+)(\S*)$/.exec(before)
  if (model) {
    if (models.length === 0) return undefined
    const candidates = models.filter((id) => id.startsWith(model[2]!)).map((id) => `${model[1]}${id}`)
    const token = `${model[1]}${model[2]}`
    const filled = resolve(token, candidates)
    if (!filled) return undefined
    const suffix = candidates.length === 1 ? " " : ""
    return { text: filled + suffix + after, cursor: filled.length + suffix.length }
  }

  return undefined
}

/** Longest common prefix of the candidates, if it extends the token. */
function resolve(token: string, candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  let prefix = candidates[0]!
  for (const candidate of candidates) {
    while (!candidate.startsWith(prefix)) prefix = prefix.slice(0, -1)
    if (prefix.length === 0) return undefined
  }
  return prefix.length > token.length ? prefix : undefined
}
