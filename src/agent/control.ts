import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * The control plane: durable records of what the human asked the agent to do.
 *
 * Records never mutate a running turn directly. The runtime consumes them at a
 * step boundary (between two model calls), and every record is also rendered in
 * the transcript as a normal user entry. The log exists so a resumed session can
 * tell what the human already decided, instead of rediscovering it from prose.
 */
export type ControlRecord =
  | { kind: "pause"; id: string; at: number }
  | { kind: "resume"; id: string; at: number }
  | { kind: "steer"; id: string; at: number; text: string; scope: "round" | "next-round" }
  | { kind: "retry"; id: string; at: number; round?: number; note?: string }
  | { kind: "abort"; id: string; at: number; round?: number }
  | { kind: "amend-goal"; id: string; at: number; text: string; revision: number }
  | { kind: "answer"; id: string; at: number; requestId: string; answer: string; choiceId?: string }

export function pauseControl(at = Date.now()): ControlRecord {
  return { kind: "pause", id: randomUUID(), at }
}

export function resumeControl(at = Date.now()): ControlRecord {
  return { kind: "resume", id: randomUUID(), at }
}

/** One human-readable line for the transcript. Control records render as user entries. */
export function formatControlRecord(record: ControlRecord): string {
  switch (record.kind) {
    case "pause":
      return "⏸ paused — the in-flight turn was discarded; the stack and views are kept"
    case "resume":
      return "▶ resumed"
    case "steer":
      return `❯ steer (${record.scope}): ${record.text}`
    case "retry":
      return `↻ retry${record.round === undefined ? "" : ` round ${record.round}`}${record.note ? ` — ${record.note}` : ""}`
    case "abort":
      return `✕ aborted${record.round === undefined ? "" : ` round ${record.round}`}`
    case "amend-goal":
      return `❖ goal revised (revision ${record.revision}): ${record.text}`
    case "answer":
      return `❯ answer${record.choiceId ? ` (${record.choiceId})` : ""}: ${record.answer}`
  }
}

/**
 * The control log lives beside the session checkpoint: `run.json` becomes
 * `run.control.jsonl`. Without a session the log is unavailable and the runtime
 * still keeps the transcript entries in memory.
 */
export function controlLogPathFor(sessionPath: string): string {
  return sessionPath.endsWith(".json")
    ? `${sessionPath.slice(0, -".json".length)}.control.jsonl`
    : `${sessionPath}.control.jsonl`
}

/** Append one record. The log is append-only and never rewritten. */
export function appendControlRecord(path: string, record: ControlRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

/** Read a log tolerantly: a torn tail line is skipped, not fatal. */
export function readControlRecords(path: string): ControlRecord[] {
  if (!existsSync(path)) return []
  const records: ControlRecord[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as ControlRecord
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string" && typeof parsed.id === "string") {
        records.push(parsed)
      }
    } catch {
      /* torn tail line from an interrupted append */
    }
  }
  return records
}
