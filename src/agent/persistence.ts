import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { SessionSnapshot } from "./types.ts"
import type { AgentRuntime } from "./runtime.ts"

export const SESSION_VERSION = 2

export type SessionData = SessionSnapshot & {
  version: number
  savedAt: number
}

/** Persist task state. File contents are never stored — only paths. */
export function saveSession(runtime: AgentRuntime, path: string): void {
  const data: SessionData = { version: SESSION_VERSION, savedAt: Date.now(), ...runtime.exportSession() }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

export function loadSession(runtime: AgentRuntime, path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as SessionData
    runtime.importSession(data)
    return true
  } catch (error) {
    throw new Error(`Failed to load session ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Autosave after state changes, debounced. */
export function attachSessionAutosave(runtime: AgentRuntime, path: string, debounceMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return runtime.bus.on((event) => {
    if (event.type !== "state.changed") return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        saveSession(runtime, path)
      } catch {
        // Autosave must never break the runtime.
      }
    }, debounceMs)
  })
}
