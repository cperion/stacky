import { PROVIDERS } from "../llm/catalog.ts"
import { COMMAND_NAMES, findCommand } from "./commands.ts"

export type Completion = { text: string; cursor: number }
export type Candidate = { value: string; description: string }
export type CompletionSet = { start: number; end: number; candidates: Candidate[] }

const ARGUMENTS: Record<string, string[]> = {
  theme: ["auto", "dark", "light"],
  ui: ["repl", "panes"],
  thinking: ["on", "off"],
  "thinking-blocks": ["on", "off"],
  dashboard: ["on", "off"],
  login: ["chatgpt"],
  logout: ["chatgpt"],
}

/** Complete the whole token at the cursor, not just its left half. */
export function completionSet(line: string, cursor: number, models: readonly Candidate[]): CompletionSet | undefined {
  cursor = Math.max(0, Math.min(cursor, line.length))
  const before = line.slice(0, cursor)
  const token = /\S*$/.exec(before)![0]
  const start = cursor - token.length
  const end = cursor + (/^\S*/.exec(line.slice(cursor))?.[0].length ?? 0)
  let candidates: Candidate[]
  const query = token.toLowerCase()
  if (start === 0 && before.startsWith("/")) {
    candidates = COMMAND_NAMES.map((name) => ({ value: `/${name}`, description: findCommand(name)!.description }))
  } else if (/^\/models?\s+refresh\s+\S*$/.test(before)) {
    candidates = PROVIDERS.map((value) => ({ value, description: "fetch this provider's model API" }))
  } else {
    const match = /^\/(\S+)\s+\S*$/.exec(before)
    if (!match) return undefined
    const command = findCommand(match[1]!)?.name
    if (!command) return undefined
    candidates = command === "model"
      ? [{ value: "refresh", description: "refresh model lists from providers" }, ...models]
      : (ARGUMENTS[command] ?? []).map((value) => ({ value, description: "" }))
  }
  // Prefix matches first; substring matching makes /model sonnet useful too.
  candidates = candidates.filter((item) => item.value.toLowerCase().includes(query))
  candidates.sort((a, b) => Number(b.value.toLowerCase().startsWith(query)) - Number(a.value.toLowerCase().startsWith(query)))
  return candidates.length ? { start, end, candidates } : undefined
}

export function applyCompletion(line: string, set: CompletionSet, candidate: Candidate): Completion {
  const after = line.slice(set.end)
  const separator = /^\s/.test(after) ? "" : " "
  const text = line.slice(0, set.start) + candidate.value + separator + after
  const cursor = set.start + candidate.value.length + (separator.length || (after.length ? 1 : 0))
  return { text, cursor }
}

/** Noninteractive completion: extend the common prefix, or accept a unique match. */
export function completeInput(line: string, cursor: number, models: readonly string[]): Completion | undefined {
  const set = completionSet(line, cursor, models.map((value) => ({ value, description: "" })))
  if (!set) return undefined
  if (set.candidates.length === 1) return applyCompletion(line, set, set.candidates[0]!)
  let prefix = set.candidates[0]!.value
  for (const item of set.candidates) {
    while (prefix && !item.value.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  if (prefix.length <= cursor - set.start) return undefined
  return { text: line.slice(0, set.start) + prefix + line.slice(set.end), cursor: set.start + prefix.length }
}

/** History browsing preserves the unfinished draft and never eats multiline arrows. */
export class PromptHistory {
  private entries: string[] = []
  private index = 0
  private draft = ""
  private recalled: string | undefined

  add(text: string): void {
    if (text.trim() && text !== this.entries.at(-1)) this.entries.push(text)
    if (this.entries.length > 200) this.entries.shift()
    this.reset()
  }

  isBrowsing(text: string): boolean { return this.recalled !== undefined && text === this.recalled }

  reset(): void {
    this.index = this.entries.length
    this.recalled = undefined
  }

  move(direction: -1 | 1, text: string): string | undefined {
    if (this.entries.length === 0) return undefined
    if (this.recalled !== undefined && text !== this.recalled) this.reset()
    if (this.recalled === undefined) {
      if (direction === 1) return undefined
      this.draft = text
    }
    this.index = Math.max(0, Math.min(this.entries.length, this.index + direction))
    this.recalled = this.entries[this.index] ?? this.draft
    return this.recalled
  }
}
