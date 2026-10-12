import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"

const MIN_ALIAS_LENGTH = 3
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const DEFAULT_EVENT_LIMIT = 100
const MAX_EVENT_LIMIT = 1_000

type JsonRecord = Record<string, unknown>

type DescriptorRow = {
  ref: string
  canonical: string
  full_hash: string
}

type EventRow = {
  ref: string
  value: string
}

export type MemoryEventFilter = {
  agentId?: string
  frameId?: string
  type?: string
  query?: string
  after?: number
  through?: number
  before?: number
  parentId?: string | null
  order?: "asc" | "desc"
  limit?: number
}

/** Durable, exact-reference registry shared by working memory and history. */
export class MemoryStore {
  readonly directory: string
  private readonly db: Database
  private readonly blobDirectory: string
  private closed = false

  constructor(directory: string) {
    this.directory = directory
    this.blobDirectory = join(directory, "blobs")
    mkdirSync(this.blobDirectory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    chmodSync(this.blobDirectory, 0o700)

    const databasePath = join(directory, "memory.sqlite")
    this.db = new Database(databasePath, { create: true, strict: true })
    chmodSync(databasePath, 0o600)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = FULL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS descriptors (
        ref TEXT PRIMARY KEY,
        full_hash TEXT NOT NULL UNIQUE,
        canonical TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_sequence (
        seq INTEGER PRIMARY KEY AUTOINCREMENT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        ref TEXT NOT NULL UNIQUE REFERENCES descriptors(ref),
        agent_id TEXT,
        frame_id TEXT,
        parent_id TEXT,
        type TEXT,
        value TEXT NOT NULL
      );
    `)
    const eventColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(events)").all()
    if (!eventColumns.some((column) => column.name === "parent_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN parent_id TEXT")
      this.db.exec("UPDATE events SET parent_id = COALESCE(json_extract(value, '$.parentId'), json_extract(value, '$.payload.parentId'))")
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS events_agent_seq ON events(agent_id, seq);
      CREATE INDEX IF NOT EXISTS events_frame_seq ON events(frame_id, seq);
      CREATE INDEX IF NOT EXISTS events_parent_seq ON events(parent_id, seq);
      CREATE INDEX IF NOT EXISTS events_type_seq ON events(type, seq);
    `)
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = databasePath + suffix
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  }

  /** Store a canonical immutable descriptor and return its permanent exact alias. */
  put(value: JsonRecord): string {
    this.assertOpen()
    const canonical = canonicalStringify(value)
    const hash = sha256(canonical)
    return this.db.transaction(() => this.putCanonical(canonical, hash))()
  }

  /** Resolve an exact alias. Prefix resolution is deliberately unsupported. */
  get(ref: string): JsonRecord {
    this.assertOpen()
    const row = this.db
      .query<Pick<DescriptorRow, "canonical">, [string]>("SELECT canonical FROM descriptors WHERE ref = ?")
      .get(ref)
    if (!row) throw new Error(`Memory reference not found: ${ref}`)
    return JSON.parse(row.canonical) as JsonRecord
  }

  /** Capture an immutable text artifact. Very large captures are explicitly marked as partial. */
  text(text: string, meta: { title: string; [key: string]: unknown }): string {
    this.assertOpen()
    if (typeof meta.title !== "string" || meta.title.length === 0) throw new Error("Text artifacts require a title")

    const original = Buffer.from(text, "utf8")
    const contentHash = sha256(original)
    const captured = original.byteLength <= MAX_CAPTURE_BYTES ? original : validUtf8Prefix(original, MAX_CAPTURE_BYTES)
    const textHash = sha256(captured)
    const blobPath = join(this.blobDirectory, textHash)
    if (!existsSync(blobPath)) this.writeBlob(blobPath, captured)

    const safeMeta = { ...meta }
    delete safeMeta.kind
    delete safeMeta.textHash
    delete safeMeta.contentHash
    delete safeMeta.bytes
    delete safeMeta.capturedBytes
    delete safeMeta.omittedBytes

    return this.put({
      ...safeMeta,
      kind: "text",
      title: meta.title,
      textHash,
      contentHash,
      bytes: original.byteLength,
      capturedBytes: captured.byteLength,
      omittedBytes: original.byteLength - captured.byteLength,
    })
  }

  loadText(ref: string): { text: string; title: string; [key: string]: unknown } {
    const descriptor = this.get(ref)
    if (descriptor.kind !== "text" || typeof descriptor.textHash !== "string" || typeof descriptor.title !== "string") {
      throw new Error(`Memory reference ${ref} is not a text artifact`)
    }
    const path = join(this.blobDirectory, descriptor.textHash)
    let blob: Buffer
    try {
      blob = readFileSync(path)
    } catch (error) {
      throw new Error(`Text blob for ${ref} is unavailable: ${errorMessage(error)}`)
    }
    if (sha256(blob) !== descriptor.textHash) throw new Error(`Text blob for ${ref} failed its integrity check`)
    const { kind: _kind, textHash: _textHash, ...meta } = descriptor
    return { ...meta, title: descriptor.title, text: blob.toString("utf8") }
  }

  /** Append an event and its immutable descriptor in one SQLite transaction. */
  record(event: JsonRecord): string {
    this.assertOpen()
    return this.db.transaction(() => {
      const sequence = this.db.query("INSERT INTO event_sequence DEFAULT VALUES").run()
      const seq = Number(sequence.lastInsertRowid)
      const value: JsonRecord = { ...event, kind: "event", seq }
      const canonical = canonicalStringify(value)
      const ref = this.putCanonical(canonical, sha256(canonical))
      this.db
        .query(
          "INSERT INTO events(seq, ref, agent_id, frame_id, parent_id, type, value) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          seq,
          ref,
          stringOrNull(event.agentId),
          stringOrNull(event.frameId),
          eventParentId(event),
          stringOrNull(event.type),
          canonical,
        )
      return ref
    })()
  }

  events(filter: MemoryEventFilter = {}): Array<{ ref: string; value: JsonRecord }> {
    this.assertOpen()
    const requestedLimit = filter.limit === undefined || !Number.isFinite(filter.limit)
      ? DEFAULT_EVENT_LIMIT
      : Math.floor(filter.limit)
    const limit = Math.max(0, Math.min(MAX_EVENT_LIMIT, requestedLimit))
    if (limit === 0) return []

    const clauses: string[] = []
    const values: Array<string | number> = []
    if (filter.agentId !== undefined) {
      clauses.push("agent_id = ?")
      values.push(filter.agentId)
    }
    if (filter.frameId !== undefined) {
      clauses.push("frame_id = ?")
      values.push(filter.frameId)
    }
    if (filter.type !== undefined) {
      clauses.push("type = ?")
      values.push(filter.type)
    }
    if (filter.parentId === null) clauses.push("parent_id IS NULL")
    else if (filter.parentId !== undefined) {
      clauses.push("parent_id = ?")
      values.push(filter.parentId)
    }
    if (filter.query !== undefined) {
      clauses.push("instr(value, ?) > 0")
      values.push(filter.query)
    }
    if (filter.after !== undefined) {
      clauses.push("seq > ?")
      values.push(filter.after)
    }
    if (filter.through !== undefined) {
      clauses.push("seq <= ?")
      values.push(filter.through)
    }
    if (filter.before !== undefined) {
      clauses.push("seq < ?")
      values.push(filter.before)
    }
    values.push(limit)

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const order = filter.order === "desc" ? "DESC" : "ASC"
    const rows = this.db
      .query<EventRow, Array<string | number>>(`SELECT ref, value FROM events ${where} ORDER BY seq ${order} LIMIT ?`)
      .all(...values)
    return rows.map((row) => ({ ref: row.ref, value: JSON.parse(row.value) as JsonRecord }))
  }

  close(): void {
    if (this.closed) return
    this.db.close()
    this.closed = true
  }

  private putCanonical(canonical: string, hash: string): string {
    const existing = this.db
      .query<DescriptorRow, [string]>("SELECT ref, canonical, full_hash FROM descriptors WHERE full_hash = ?")
      .get(hash)
    if (existing) {
      if (existing.canonical !== canonical) throw new Error("SHA-256 descriptor identity collision")
      return existing.ref
    }

    let length = MIN_ALIAS_LENGTH
    let ref = hash.slice(0, length)
    while (this.db.query("SELECT 1 FROM descriptors WHERE ref = ?").get(ref)) {
      length += 1
      if (length > hash.length) throw new Error("Unable to allocate an exact memory alias")
      ref = hash.slice(0, length)
    }
    this.db
      .query("INSERT INTO descriptors(ref, full_hash, canonical, created_at) VALUES (?, ?, ?, ?)")
      .run(ref, hash, canonical, Date.now())
    return ref
  }

  private writeBlob(path: string, content: Uint8Array): void {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: "wx" })
      renameSync(temporary, path)
      chmodSync(path, 0o600)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // Cleanup is best-effort; the original durable-write error is preserved.
      }
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Memory store is closed")
  }
}

function canonicalStringify(value: unknown): string {
  const active = new Set<object>()
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Memory descriptors require finite numbers")
      return item
    }
    if (Array.isArray(item)) {
      if (active.has(item)) throw new Error("Memory descriptors cannot contain cycles")
      active.add(item)
      const result = item.map((entry) => {
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
          throw new Error("Memory descriptors contain an unsupported array value")
        }
        return normalize(entry)
      })
      active.delete(item)
      return result
    }
    if (typeof item === "object") {
      if (active.has(item)) throw new Error("Memory descriptors cannot contain cycles")
      active.add(item)
      const record = item as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) {
        const entry = record[key]
        if (entry === undefined) continue
        if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
          throw new Error(`Memory descriptor field ${key} has an unsupported value`)
        }
        result[key] = normalize(entry)
      }
      active.delete(item)
      return result
    }
    throw new Error("Memory descriptor is not JSON serializable")
  }
  return JSON.stringify(normalize(value))
}

function validUtf8Prefix(value: Buffer, maximum: number): Buffer {
  let end = Math.min(maximum, value.byteLength)
  while (end > 0 && (value[end] ?? 0) >= 0x80 && (value[end] ?? 0) < 0xc0) end -= 1
  return value.subarray(0, end)
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function eventParentId(event: JsonRecord): string | null {
  const direct = stringOrNull(event.parentId)
  if (direct !== null) return direct
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null
  return stringOrNull((event.payload as JsonRecord).parentId)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
