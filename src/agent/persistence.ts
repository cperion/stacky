import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { SessionSnapshot } from "./types.ts"
import type { AgentRuntime } from "./runtime.ts"

export const SESSION_VERSION = 3

export type SessionData = SessionSnapshot & {
  version: number
  savedAt: number
}

/** Session checkpoints reference the separate durable archive; no file bodies are embedded here. */
export function saveSession(runtime: AgentRuntime, path: string): void {
  const data: SessionData = { version: SESSION_VERSION, savedAt: Date.now(), ...runtime.exportSession() }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

export function loadSession(runtime: AgentRuntime, path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as SessionData
    if (!data || typeof data !== "object" || !Array.isArray(data.stack) || !Array.isArray(data.conversation)) throw new Error("Invalid session checkpoint")
    if (data.version > SESSION_VERSION) throw new Error(`Unsupported session version ${data.version}`)
    runtime.importSession(data)
    return true
  } catch (error) {
    throw new Error(`Failed to load session ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Autosave after state changes, debounced. */
export function attachSessionAutosave(runtime: AgentRuntime, path: string, debounceMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = runtime.bus.on((event) => {
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
  return () => { unsubscribe(); if (timer) clearTimeout(timer) }
}
