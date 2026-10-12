import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") try { unlinkSync(temporary) } catch {}
    throw error
  }
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
  let lastFailure = ""
  const unsubscribe = runtime.bus.on((event) => {
    if (event.type !== "state.changed") return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        saveSession(runtime, path)
        lastFailure = ""
      } catch (error) {
        const message = `Session checkpoint was not saved: ${error instanceof Error ? error.message : String(error)}`
        const failureKey = (error as NodeJS.ErrnoException)?.code ?? message
        if (failureKey !== lastFailure) {
          lastFailure = failureKey
          try { runtime.note(message) } catch { runtime.bus.emit({ type: "fatal", message }) }
        }
      }
    }, debounceMs)
  })
  return () => { unsubscribe(); if (timer) clearTimeout(timer) }
}
