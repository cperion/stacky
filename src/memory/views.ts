import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { estimateTokens } from "../agent/conversation.ts"
import { MemoryStore } from "./store.ts"

const DEFAULT_BUDGET = 100_000
const DEFAULT_VIEW_BUDGET = 4_096
const MIN_VIEW_TOKENS = 24

export type MemoryResult = {
  ok: boolean
  message: string
  ref?: string
  /** Immutable source snapshot for human expansion; not an additional model view. */
  outputRef?: string
  evicted: string[]
}

export type AnchorEdit = {
  from?: string
  through?: string
  before?: string
  after?: string
  text: string
}

export type WorkspaceMemoryOptions = {
  cwd: string
  store: MemoryStore
  budgetTokens?: number
  resolveDocument?: (ref: string, find?: string) => { text: string; title: string; searched?: boolean } | undefined
}

type OldEdit = { oldText: string; newText: string; replaceAll?: boolean }

type ParsedLine = {
  text: string
  start: number
  contentEnd: number
  end: number
  newline: string
}

type View = {
  key: string
  sourceRef: string
  fileRef?: string
  path?: string
  title: string
  live: boolean
  pinned: boolean
  versionRef: string
  revision: string
  complete: boolean
  cursorLine: number
  cursorChar: number
  limitTokens: number
  lastUsed: number
  stableIndex: number
  tokenCount: number
  rendered: string
  visibleAnchors: Map<string, number>
  visibleLines: Set<number>
  endLine: number
  endChar: number
  atEnd: boolean
  beforeContext?: string
  afterContext?: string
  coveredWholeDocument: boolean
  recoveryPath?: string
  invalidReason?: string
}

type LoadedDocument = {
  sourceRef: string
  fileRef?: string
  path?: string
  title: string
  live: boolean
  versionRef: string
  revision: string
  text: string
  complete: boolean
  startLine?: number
  startChar?: number
  searched?: boolean
  recoveryPath?: string
}

type Replacement = { start: number; end: number; text: string; label: string }

type ExportedView = {
  kind: "live" | "historical"
  path?: string
  ref?: string
  versionRef?: string
  line: number
  char: number
  limitTokens: number
}

/** Reference-addressed LRU views with non-evictable repository instructions. */
export class WorkspaceMemory {
  readonly store: MemoryStore
  readonly cwd: string
  budgetTokens: number
  private readonly resolveDocument?: WorkspaceMemoryOptions["resolveDocument"]
  private views = new Map<string, View>()
  private clock = 0
  private stableCounter = 0
  private notices: string[] = []
  private instructionDirectories = new Set<string>()
  private instructionPaths = new Set<string>()
  private instructionScopes = new Map<string, Set<string>>()

  constructor(options: WorkspaceMemoryOptions) {
    this.cwd = resolve(options.cwd)
    this.store = options.store
    this.budgetTokens = normalizeBudget(options.budgetTokens ?? DEFAULT_BUDGET)
    this.resolveDocument = options.resolveDocument
    this.discoverInstructions(this.cwd)
  }

  read(input: { path?: string; ref?: string; find?: string; budgetTokens?: number } | string): MemoryResult {
    const request = typeof input === "string" ? { path: input } : input
    if ((request.path === undefined) === (request.ref === undefined)) {
      return failure("Provide exactly one of path or ref")
    }
    const limit = Math.min(this.budgetTokens, normalizeBudget(request.budgetTokens ?? Math.min(DEFAULT_VIEW_BUDGET, this.budgetTokens)))
    if (limit < MIN_VIEW_TOKENS) {
      return failure(`View budget must be at least ${MIN_VIEW_TOKENS} tokens`)
    }

    try {
      let loaded = request.path !== undefined
        ? this.loadLivePath(request.path)
        : this.loadReference(request.ref as string, request.find)
      if (!loaded) return failure(`Reference ${request.ref} is not readable. Recovery: verify the exact ref.`)

      if (request.find !== undefined && request.find.length > 0 && !loaded.searched) {
        const start = parseLines(loaded.text)[loaded.startLine ?? 0]?.start ?? 0
        loaded = this.searchDocument(loaded, request.find, start + (loaded.startChar ?? 0))
      }
      const cursorLine = loaded.startLine ?? 0
      const cursorChar = loaded.startChar ?? 0
      const { view, evicted } = this.promote(loaded, cursorLine, cursorChar, limit)
      return {
        ok: true,
        message: `Loaded ${loaded.live ? "LIVE" : "READ_ONLY"} ${loaded.title} · ${loaded.live ? `current ${loaded.fileRef}` : `ref ${loaded.sourceRef}`} · snapshot ${view.versionRef}${view.atEnd ? "" : "; continuation is in working context"}.`,
        ref: loaded.live ? loaded.fileRef : loaded.sourceRef,
        outputRef: this.store.get(view.versionRef).snapshotRef as string,
        evicted,
      }
    } catch (error) {
      return failure(errorMessage(error))
    }
  }

  capture(text: string, meta: { title: string; [key: string]: unknown }): MemoryResult {
    const ref = this.store.text(text, meta)
    if (this.budgetTokens < MIN_VIEW_TOKENS) {
      return { ok: false, message: `Captured ${meta.title} as ${ref}, but the view budget is below ${MIN_VIEW_TOKENS} tokens.`, ref, evicted: [] }
    }
    const descriptor = this.store.loadText(ref)
    const loaded = this.loadImmutableText(ref, descriptor.text, descriptor.title, descriptor.omittedBytes === 0 && descriptor.upstreamTruncated !== true)
    try {
      const { view, evicted } = this.promote(loaded, 0, 0, Math.min(DEFAULT_VIEW_BUDGET, this.budgetTokens))
      return {
        ok: true,
        message: `Captured ${meta.title} as ${ref}${view.atEnd ? "" : "; continuation is in working context"}.`,
        ref,
        evicted,
      }
    } catch (error) {
      return { ok: false, message: `Captured ${meta.title} as ${ref}, but ${errorMessage(error)}.`, ref, evicted: [] }
    }
  }

  edit(input: { edits: AnchorEdit[] } | { path: string; edits: OldEdit[] }): MemoryResult {
    try {
      let path = "path" in input ? input.path : undefined
      if (!path) {
        const edit = input.edits[0] as AnchorEdit | undefined
        const ref = edit?.from ?? edit?.before ?? edit?.after
        if (ref) {
          const anchor = this.store.get(ref)
          if (typeof anchor.versionRef === "string") {
            const version = this.store.get(anchor.versionRef)
            if (typeof version.path === "string") path = version.path
          }
        }
      }
      if (path && this.discoverInstructions(dirname(resolvePath(this.cwd, path)))) {
        return failure("Applicable AGENTS.md instructions changed or were discovered. Review the pinned instructions in the next context before retrying this edit.")
      }
    } catch (error) { return failure(errorMessage(error)) }
    if ("path" in input) return this.editByText(input.path, input.edits)
    return this.editByAnchors(input.edits)
  }

  /** Refreshes live ranges without touching recency, then renders stable-order views. */
  materialize(): string {
    for (const view of this.views.values()) {
      if (!view.live || !view.path) continue
      try { this.watchInstructionDirectories(dirname(realpathSync(resolvePath(this.cwd, view.path)))) } catch {
        // Unavailable code views are invalidated below; existing guidance still refreshes.
      }
    }
    this.refreshInstructions()
    this.refreshLiveViews()
    this.notices.push(...this.evictToBudget())
    return this.combinedRendered()
  }

  /** Share discovered guidance across delegation without copying code/log views. */
  inheritInstructions(other: WorkspaceMemory): void {
    for (const directory of other.instructionDirectories) this.watchInstructionDirectories(directory)
    this.refreshInstructions()
  }

  takeNotices(): string[] {
    const notices = this.notices
    this.notices = []
    return notices
  }

  /** Compatibility listing: multiple resident views of one live file are grouped. */
  list(): Array<{ path: string; lastUsed: number; tokenCount: number; stableIndex: number }> {
    const grouped = new Map<string, { path: string; lastUsed: number; tokenCount: number; stableIndex: number }>()
    for (const view of this.views.values()) {
      if (!view.live || !view.path) continue
      const current = grouped.get(view.path)
      if (!current) {
        grouped.set(view.path, {
          path: view.path,
          lastUsed: view.lastUsed,
          tokenCount: view.tokenCount,
          stableIndex: view.stableIndex,
        })
      } else {
        current.lastUsed = Math.max(current.lastUsed, view.lastUsed)
        current.tokenCount += view.tokenCount
        current.stableIndex = Math.min(current.stableIndex, view.stableIndex)
      }
    }
    return [...grouped.values()].sort((a, b) => b.lastUsed - a.lastUsed)
  }

  totalTokens(): number {
    return estimateTokens(this.combinedRendered())
  }

  summary(): { views: number; liveViews: number; usedTokens: number; budgetTokens: number } {
    return { views: this.views.size, liveViews: [...this.views.values()].filter((view) => view.live).length,
      usedTokens: this.totalTokens(), budgetTokens: this.budgetTokens }
  }

  setBudget(tokens: number): string[] {
    this.budgetTokens = normalizeBudget(tokens)
    if (this.budgetTokens < MIN_VIEW_TOKENS) {
      const receipts = [...this.views.values()].filter((view) => !view.pinned).map((view) => this.viewLabel(view))
      for (const [key, view] of this.views) if (!view.pinned) this.views.delete(key)
      return receipts
    }
    const evicted: string[] = []
    for (const view of [...this.views.values()]) {
      if (!view.pinned && view.limitTokens > this.budgetTokens) {
        view.limitTokens = this.budgetTokens
        const text = this.textForView(view)
        try {
          if (text === undefined) throw new Error("snapshot unavailable")
          this.render(view, text)
        } catch {
          this.views.delete(view.key)
          evicted.push(this.viewLabel(view))
        }
      }
    }
    evicted.push(...this.evictToBudget())
    return evicted
  }

  clear(): void {
    this.views.clear()
    this.notices = []
    this.instructionPaths.clear()
    this.instructionScopes.clear()
    this.discoverInstructions(this.cwd)
  }

  restorePaths(paths: string[]): void {
    this.clear()
    for (const path of paths) this.read({ path })
  }

  exportViews(): unknown[] {
    const selections = [...this.views.values()].filter((view) => !view.pinned).map((view): ExportedView => view.live && view.path
      ? {
          kind: "live",
          path: view.path,
          versionRef: view.versionRef,
          line: view.cursorLine,
          char: view.cursorChar,
          limitTokens: view.limitTokens,
        }
      : {
          kind: "historical",
          ref: this.pageRef(view, view.cursorLine, view.cursorChar),
          line: view.cursorLine,
          char: view.cursorChar,
          limitTokens: view.limitTokens,
        })
    return [{ kind: "instructions", directories: [...this.instructionDirectories],
      files: [...this.views.values()].filter((view) => view.pinned).map((view) => ({ path: view.path, versionRef: view.versionRef })) }, ...selections]
  }

  restoreViews(values: unknown[]): void {
    this.clear()
    if (!Array.isArray(values)) return
    for (const value of values) {
      if (value && typeof value === "object" && "kind" in value && value.kind === "instructions" && "directories" in value && Array.isArray(value.directories)) {
        for (const directory of value.directories) if (typeof directory === "string") this.watchInstructionDirectories(directory)
      }
    }
    this.refreshInstructions()
    for (const value of values) {
      if (!isExportedView(value)) continue
      try {
        const loaded = value.kind === "live" && value.path
          ? this.loadLivePath(value.path)
          : value.ref
            ? this.loadReference(value.ref)
            : undefined
        if (!loaded) continue
        if (value.kind === "live") {
          if (typeof value.versionRef !== "string") continue
          const savedVersion = this.store.get(value.versionRef)
          // File beginnings remain meaningful after changes; nonzero semantic
          // selections require a fresh explicit read rather than guessing an anchor.
          if (savedVersion.revision !== loaded.revision && (value.line !== 0 || value.char !== 0)) {
            this.notices.push(`Saved region changed; read({path:${quote(value.path!)}}) to locate it again`)
            continue
          }
        }
        this.promote(
          loaded,
          value.kind === "live" ? value.line : (loaded.startLine ?? 0),
          value.kind === "live" ? value.char : (loaded.startChar ?? 0),
          Math.min(this.budgetTokens, normalizeBudget(value.limitTokens)),
        )
      } catch {
        this.notices.push(`Saved view unavailable; ${value.path ? `read({path:${quote(value.path)}})` : `read({ref:${quote(value.ref ?? "unknown")}})`}`)
      }
    }
  }

  /** Watch ancestors, not descendants: unrelated nested guidance is not loaded. */
  private watchInstructionDirectories(directory: string): void {
    const watch = (start: string) => {
      for (let current = resolve(start); ; current = dirname(current)) {
        this.instructionDirectories.add(current)
        if (dirname(current) === current) break
      }
    }
    watch(directory)
    try { watch(realpathSync(directory)) } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
    }
  }

  private discoverInstructions(directory: string): boolean {
    this.watchInstructionDirectories(directory)
    return this.refreshInstructions()
  }

  private instructionScopeLabel(path: string): string {
    return [...(this.instructionScopes.get(resolvePath(this.cwd, path)) ?? [])]
      .sort().map((scope) => `${displayPath(this.cwd, scope) || "."}/`).join(", ")
  }

  private refreshInstructions(): boolean {
    const scopes = new Map<string, Set<string>>()
    for (const directory of this.instructionDirectories) {
      const candidate = join(directory, "AGENTS.md")
      try {
        if (!lstatSync(candidate, { throwIfNoEntry: false })) continue
        const path = realpathSync(candidate)
        const directories = scopes.get(path) ?? new Set<string>()
        directories.add(directory)
        scopes.set(path, directories)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") continue
        throw new Error(`Cannot load instructions ${candidate}: ${errorMessage(error)}`)
      }
    }
    const previousScopes = this.instructionScopes
    this.instructionScopes = scopes
    this.instructionPaths = new Set(scopes.keys())
    let changed = false
    for (const view of [...this.views.values()]) {
      if (view.pinned && !this.instructionPaths.has(resolvePath(this.cwd, view.path!))) {
        this.views.delete(view.key)
        changed = true
      }
    }
    for (const [path, directories] of scopes) {
      const loaded = this.loadFileDocument(path)
      const existing = [...this.views.values()].find((view) => view.pinned && resolvePath(this.cwd, view.path!) === path)
      const scopesChanged = [...directories].sort().join("\n") !== [...(previousScopes.get(path) ?? [])].sort().join("\n")
      if (existing?.revision === loaded.revision && !scopesChanged) continue
      if (!loaded.complete) throw new Error(`Cannot load complete AGENTS.md instructions from ${path}; capture limit exceeded.`)
      if (existing) this.views.delete(existing.key)
      const result = this.promote(loaded, 0, 0, DEFAULT_VIEW_BUDGET)
      result.view.lastUsed = existing?.lastUsed ?? 0 // automatic refresh is not an access
      if (existing) result.view.stableIndex = existing.stableIndex
      this.notices.push(...result.evicted)
      changed = true
    }
    this.notices.push(...this.evictToBudget())
    return changed
  }

  private loadLivePath(path: string): LoadedDocument {
    const absolute = resolvePath(this.cwd, path)
    const stat = statSync(absolute)
    this.discoverInstructions(stat.isDirectory() ? absolute : dirname(absolute))
    if (stat.isDirectory()) {
      const shownPath = displayPath(this.cwd, absolute) || "."
      const ref = this.store.put({ kind: "directory", path: shownPath, absolutePath: absolute })
      const text = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => JSON.stringify(entry.name + (entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""))).join("\n")
      return this.loadImmutableText(ref, text || "(empty directory)", `Directory ${shownPath}`)
    }
    const physical = realpathSync(absolute)
    this.discoverInstructions(dirname(physical))
    return this.loadFileDocument(this.instructionPaths.has(physical) ? physical : absolute)
  }

  private loadFileDocument(absolute: string): LoadedDocument {
    const shownPath = displayPath(this.cwd, absolute)
    const stat = statSync(absolute)
    if (!stat.isFile()) throw new Error(`Path is not a file: ${shownPath}`)
    if (stat.size > 64 * 1024 * 1024) throw new Error(`File exceeds the 64 MiB safety limit: ${shownPath}. Use a bounded shell query to inspect selected output.`)
    const text = readSource(absolute)
    const fileRef = this.store.put({ kind: "file", path: shownPath, absolutePath: absolute })
    return this.versionDocument({
      sourceRef: fileRef,
      fileRef,
      path: shownPath,
      title: shownPath,
      live: true,
      text,
    })
  }

  private loadReference(ref: string, find?: string): LoadedDocument | undefined {
    let descriptor: Record<string, unknown>
    try {
      descriptor = this.store.get(ref)
    } catch (error) {
      throw new Error(`${errorMessage(error)}. Recovery: use an exact reference from working context or history.`)
    }

    if ((descriptor.kind === "file" || descriptor.kind === "directory") && typeof descriptor.path === "string") {
      return this.loadLivePath(typeof descriptor.absolutePath === "string" ? descriptor.absolutePath : descriptor.path)
    }
    if (descriptor.kind === "text") {
      const artifact = this.store.loadText(ref)
      return this.loadImmutableText(ref, artifact.text, artifact.title, artifact.omittedBytes === 0 && artifact.upstreamTruncated !== true)
    }
    if (descriptor.kind === "file-version" || descriptor.kind === "document-version") {
      return this.loadVersion(ref, descriptor)
    }
    if (descriptor.kind === "line" && typeof descriptor.versionRef === "string" && typeof descriptor.line === "number") {
      const loaded = this.loadVersion(descriptor.versionRef)
      return { ...loaded, sourceRef: ref, title: `${loaded.title} line ${descriptor.line + 1}`, startLine: descriptor.line, startChar: 0 }
    }
    if (
      descriptor.kind === "page" &&
      typeof descriptor.versionRef === "string" &&
      typeof descriptor.line === "number" &&
      typeof descriptor.char === "number"
    ) {
      return { ...this.loadVersion(descriptor.versionRef), sourceRef: ref, startLine: descriptor.line, startChar: descriptor.char }
    }
    if (
      descriptor.kind === "file-page" &&
      typeof descriptor.versionRef === "string" &&
      typeof descriptor.fileRef === "string" &&
      typeof descriptor.path === "string" &&
      typeof descriptor.revision === "string" &&
      typeof descriptor.line === "number" &&
      typeof descriptor.char === "number"
    ) {
      const snapshot = this.loadVersion(descriptor.versionRef)
      let current: LoadedDocument | undefined
      let recoveryPath = descriptor.path
      try {
        const resource = this.store.get(descriptor.fileRef)
        if (typeof resource.absolutePath !== "string") throw new Error("File identity is missing")
        recoveryPath = resource.absolutePath
        const fresh = this.loadLivePath(resource.absolutePath)
        if (fresh.revision === descriptor.revision) current = fresh
      } catch {
        // The exact old snapshot remains readable even if the current resource is unavailable.
      }
      return current
        ? {
            ...current,
            startLine: descriptor.line,
            startChar: descriptor.char,
          }
        : {
            ...snapshot,
            sourceRef: ref,
            live: false,
            startLine: descriptor.line,
            startChar: descriptor.char,
            recoveryPath: displayPath(this.cwd, resolvePath(this.cwd, recoveryPath)),
          }
    }

    if (descriptor.kind === "search-page" && typeof descriptor.versionRef === "string" && typeof descriptor.query === "string" && typeof descriptor.after === "number") {
      const original = this.loadVersion(descriptor.versionRef)
      // This flag only constructs file-page links. Opening each link independently
      // checks the actual revision before granting live file authority.
      return this.searchDocument({ ...original, live: descriptor.live === true }, find ?? descriptor.query, descriptor.after)
    }

    const resolved = this.resolveDocument?.(ref, find)
    if (!resolved) return undefined
    return { ...this.loadImmutableText(ref, resolved.text, resolved.title), searched: resolved.searched }
  }

  private searchDocument(source: LoadedDocument, query: string, after = 0): LoadedDocument {
    const searchRef = this.store.put({ kind: "search-page", versionRef: source.versionRef, query, after, live: source.live })
    const lines = parseLines(source.text)
    const output = [`# Literal matches in ${source.title}`, `Query: ${JSON.stringify(query.slice(0, 240))}`, `Snapshot: ${source.versionRef}. Open a match to inspect its context; snippets do not authorize edits.`]
    let position = source.text.indexOf(query, after)
    let count = 0
    while (position >= 0 && count < 20) {
      const line = lineAtOffset(lines, position)
      const cursorLine = Math.max(0, line - 2)
      const currentLine = lines[line]!
      const inLine = position - currentLine.start
      const fragmented = currentLine.text.length > 2000
      const target = this.store.put({
        kind: source.live && source.fileRef && source.path ? "file-page" : "page",
        versionRef: source.versionRef, revision: source.revision,
        ...(source.fileRef ? { fileRef: source.fileRef } : {}), ...(source.path ? { path: source.path } : {}),
        line: fragmented ? line : cursorLine,
        char: fragmented ? safeCodePointStart(currentLine.text, Math.max(0, inLine - 40)) : 0,
        title: source.title,
      })
      const snippet = currentLine.text.slice(Math.max(0, inLine - 40), inLine + Math.min(query.length, 100) + 80)
      output.push(`Line ${line + 1}: read({ref:${quote(target)}}) · ${JSON.stringify(snippet)}`)
      count++
      position = source.text.indexOf(query, position + Math.max(1, query.length))
    }
    if (count === 0) output.push("No literal matches in this captured source.")
    if (position >= 0) {
      const next = this.store.put({ kind: "search-page", versionRef: source.versionRef, query, after: position, live: source.live })
      output.push(`More matches: read({ref:${quote(next)}})`)
    }
    if (!source.complete) output.push("Search covers captured content only; omitted bytes are unavailable.")
    return { ...this.loadImmutableText(searchRef, output.join("\n"), `Search · ${source.title}`), searched: true }
  }

  private loadImmutableText(ref: string, text: string, title: string, complete = true): LoadedDocument {
    return this.versionDocument({ sourceRef: ref, title, live: false, text, complete })
  }

  private versionDocument(input: {
    sourceRef: string
    fileRef?: string
    path?: string
    title: string
    live: boolean
    text: string
    complete?: boolean
  }): LoadedDocument {
    const revision = hashText(input.text)
    const snapshotRef = this.store.text(input.text, {
      title: `${input.title} @ ${revision.slice(0, 12)}`,
      role: "memory-version",
      sourceRef: input.sourceRef,
      ...(input.path ? { path: input.path } : {}),
    })
    const snapshot = this.store.get(snapshotRef)
    const captured = this.store.loadText(snapshotRef)
    const complete = input.complete !== false && snapshot.omittedBytes === 0
    const descriptor: Record<string, unknown> = {
      kind: input.live ? "file-version" : "document-version",
      sourceRef: input.sourceRef,
      revision,
      snapshotRef,
      title: input.title,
      complete,
      ...(input.fileRef ? { fileRef: input.fileRef } : {}),
      ...(input.path ? { path: input.path } : {}),
    }
    const versionRef = this.store.put(descriptor)
    return { ...input, text: captured.text, versionRef, revision, complete }
  }

  private loadVersion(ref: string, known?: Record<string, unknown>): LoadedDocument {
    const descriptor = known ?? this.store.get(ref)
    if (
      (descriptor.kind !== "file-version" && descriptor.kind !== "document-version") ||
      typeof descriptor.snapshotRef !== "string" ||
      typeof descriptor.sourceRef !== "string" ||
      typeof descriptor.revision !== "string" ||
      typeof descriptor.title !== "string"
    ) throw new Error(`Reference ${ref} is not a readable version`)
    const snapshot = this.store.loadText(descriptor.snapshotRef)
    return {
      sourceRef: descriptor.sourceRef,
      ...(typeof descriptor.fileRef === "string" ? { fileRef: descriptor.fileRef } : {}),
      ...(typeof descriptor.path === "string" ? { path: descriptor.path } : {}),
      title: descriptor.title,
      live: false,
      versionRef: ref,
      revision: descriptor.revision,
      text: snapshot.text,
      complete: descriptor.complete === true,
    }
  }

  private promote(
    loaded: LoadedDocument,
    cursorLine: number,
    cursorChar: number,
    limitTokens: number,
  ): { view: View; evicted: string[] } {
    const pinned = Boolean(loaded.live && loaded.path && this.instructionPaths.has(resolvePath(this.cwd, loaded.path)))
    const residentPin = [...this.views.values()].find((view) => view.pinned && loaded.live && view.versionRef === loaded.versionRef)
    if (residentPin) { residentPin.lastUsed = ++this.clock; return { view: residentPin, evicted: [] } }
    const lines = parseLines(loaded.text)
    if (pinned) {
      if (!loaded.complete) throw new Error(`Cannot load complete instructions from ${loaded.path}; capture limit exceeded.`)
      cursorLine = 0
      cursorChar = 0
      limitTokens = estimateTokens(loaded.text) + lines.length * 40 + estimateTokens(loaded.path ?? "") * 4 + estimateTokens(this.instructionScopeLabel(loaded.path!)) + 1024
    } else {
      const pins = [...this.views.values()].filter((view) => view.pinned).map((view) => view.rendered).join("\n")
      limitTokens = Math.min(limitTokens, this.budgetTokens - (pins ? estimateTokens(pins) + 1 : 0))
      if (limitTokens < MIN_VIEW_TOKENS) throw new Error("Pinned AGENTS.md instructions occupy the working-view budget; increase the budget to load other views.")
    }
    let safeLine = Math.max(0, Math.min(lines.length - 1, cursorLine))
    let lineText = lines[safeLine]?.text ?? ""
    let safeChar = safeCodePointStart(lineText, Math.max(0, Math.min(lineText.length, cursorChar)))
    if (safeChar > 0 && safeChar >= lineText.length && safeLine + 1 < lines.length) {
      safeLine += 1
      lineText = lines[safeLine]?.text ?? ""
      safeChar = 0
    }

    // Reuse only genuinely displayed content, and never cross live/historical authority modes.
    const reusable = [...this.views.values()].find((view) =>
      view.versionRef === loaded.versionRef &&
      view.live === loaded.live &&
      view.limitTokens === limitTokens &&
      !view.invalidReason &&
      safeChar === 0 &&
      view.visibleLines.has(safeLine)
    )
    if (reusable) {
      reusable.lastUsed = ++this.clock
      return { view: reusable, evicted: [] }
    }

    const view: View = {
      key: randomUUID(),
      sourceRef: loaded.sourceRef,
      ...(loaded.fileRef ? { fileRef: loaded.fileRef } : {}),
      ...(loaded.path ? { path: loaded.path } : {}),
      title: loaded.title,
      live: loaded.live,
      pinned,
      versionRef: loaded.versionRef,
      revision: loaded.revision,
      complete: loaded.complete,
      cursorLine: safeLine,
      cursorChar: safeChar,
      limitTokens,
      lastUsed: ++this.clock,
      stableIndex: this.stableCounter++,
      tokenCount: 0,
      rendered: "",
      visibleAnchors: new Map(),
      visibleLines: new Set(),
      endLine: safeLine,
      endChar: safeChar,
      atEnd: false,
      coveredWholeDocument: false,
      ...(loaded.recoveryPath ? { recoveryPath: loaded.recoveryPath } : {}),
    }
    this.render(view, loaded.text)
    if (pinned && !view.atEnd) throw new Error(`Cannot fit complete pinned instructions: ${loaded.path}`)

    const evicted: string[] = []
    for (const existing of [...this.views.values()]) {
      if (
        existing.versionRef === view.versionRef &&
        existing.live === view.live &&
        !existing.invalidReason &&
        displayedRangesOverlap(existing, view)
      ) {
        this.views.delete(existing.key)
        evicted.push(this.viewLabel(existing))
      }
    }
    this.views.set(view.key, view)
    evicted.push(...this.evictToBudget(view.key))
    return { view, evicted }
  }

  private render(view: View, text: string): void {
    this.store.batch(() => this.renderView(view, text))
  }

  private renderView(view: View, text: string): void {
    const lines = parseLines(text)
    view.visibleAnchors.clear()
    view.visibleLines.clear()
    view.invalidReason = undefined
    view.cursorLine = Math.max(0, Math.min(lines.length - 1, view.cursorLine))
    const cursorText = lines[view.cursorLine]?.text ?? ""
    view.cursorChar = safeCodePointStart(cursorText, Math.max(0, Math.min(cursorText.length, view.cursorChar)))

    const source = view.pinned
      ? `PINNED INSTRUCTIONS (LIVE) ${view.path} · scope ${this.instructionScopeLabel(view.path!)} and descendants`
      : view.live ? `LIVE ${view.path ?? view.title}` : `READ-ONLY ${view.title}`
    let body = `## ${source} ref=${view.sourceRef} version=${view.versionRef}\n`
    if (view.recoveryPath) {
      body += `[snapshot page; current-file recovery: read(path=${quote(view.recoveryPath)})]\n`
    }
    if (!view.complete) body += "[snapshot partial: omitted bytes are unavailable]\n"

    const footerPreview = (line: number): string => line < lines.length
      ? `Next: read(ref=${quote("f".repeat(64))})\n`
      : view.complete ? "" : "[capture quota reached; omitted bytes are unavailable]\n"
    const footerAt = (line: number, char: number): string => line < lines.length
      ? `Next: read(ref=${quote(this.pageRef(view, line, char))})\n`
      : view.complete ? "" : "[capture quota reached; omitted bytes are unavailable]\n"

    let lineIndex = view.cursorLine
    let charIndex = view.cursorChar
    let renderedUnit = false
    while (lineIndex < lines.length) {
      const line = lines[lineIndex] as ParsedLine
      if (charIndex === 0 && (view.complete || lineIndex < lines.length - 1)) {
        const anchor = this.store.put({ kind: "line", versionRef: view.versionRef, line: lineIndex })
        const record = `[${anchor}|${lineIndex + 1}] ${line.text}\n`
        const nextLine = lineIndex + 1
        if (estimateTokens(body + record + footerPreview(nextLine)) <= view.limitTokens) {
          body += record
          view.visibleAnchors.set(anchor, lineIndex)
          view.visibleLines.add(lineIndex)
          renderedUnit = true
          lineIndex = nextLine
          continue
        }
      }

      const ends = codePointEnds(line.text, charIndex, view.limitTokens * 4)
      let low = 0
      let high = ends.length - 1
      let acceptedEnd: number | undefined
      let acceptedRecord = ""
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const end = ends[middle] as number
        const nextLine = end >= line.text.length ? lineIndex + 1 : lineIndex
        const record = `[fragment line ${lineIndex + 1} chars ${charIndex + 1}-${end} read-only] ${line.text.slice(charIndex, end)}\n`
        if (estimateTokens(body + record + footerPreview(nextLine)) <= view.limitTokens) {
          acceptedEnd = end
          acceptedRecord = record
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      if (acceptedEnd === undefined) {
        if (renderedUnit && estimateTokens(body + footerPreview(lineIndex)) <= view.limitTokens) break
        const oneEnd = ends[0] ?? charIndex
        const sample = oneEnd > charIndex
          ? `[fragment line ${lineIndex + 1} chars ${charIndex + 1}-${oneEnd} read-only] ${line.text.slice(charIndex, oneEnd)}\n`
          : ""
        const required = estimateTokens(body + sample + footerPreview(lineIndex))
        throw new Error(`View budget ${view.limitTokens} cannot fit metadata and one content unit; use at least ${required} tokens`)
      }
      body += acceptedRecord
      renderedUnit = true
      charIndex = acceptedEnd
      if (charIndex >= line.text.length) {
        lineIndex += 1
        charIndex = 0
      }
      break
    }

    if (!renderedUnit && lines.length > 0) {
      throw new Error(`View budget ${view.limitTokens} cannot fit metadata and one content unit`)
    }
    const footer = footerAt(lineIndex, charIndex)
    const rendered = body + footer
    if (estimateTokens(rendered) > view.limitTokens) {
      throw new Error(`View renderer exceeded its ${view.limitTokens}-token budget`)
    }
    if (lineIndex === view.cursorLine && charIndex === view.cursorChar && lineIndex < lines.length) {
      throw new Error("View pagination made no progress")
    }

    view.rendered = rendered
    view.tokenCount = estimateTokens(rendered)
    view.endLine = Math.min(lines.length - 1, charIndex > 0 ? lineIndex : Math.max(view.cursorLine, lineIndex - 1))
    view.endChar = charIndex
    view.atEnd = lineIndex >= lines.length
    view.coveredWholeDocument = view.cursorLine === 0 && view.cursorChar === 0 && view.atEnd && view.complete
    view.beforeContext = view.cursorLine > 0 ? lines[view.cursorLine - 1]?.text : undefined
    const afterIndex = lineIndex + (charIndex > 0 ? 1 : 0)
    view.afterContext = afterIndex < lines.length ? lines[afterIndex]?.text : undefined
  }

  private pageRef(view: View, line: number, char: number): string {
    return view.live && view.fileRef && view.path
      ? this.store.put({
          kind: "file-page",
          versionRef: view.versionRef,
          fileRef: view.fileRef,
          path: view.path,
          revision: view.revision,
          line,
          char,
          title: view.title,
        })
      : this.store.put({ kind: "page", versionRef: view.versionRef, line, char, title: view.title })
  }

  private refreshLiveViews(): void {
    const live = [...this.views.values()].filter((view) => view.live && view.path && !view.pinned)
    for (const view of live) {
      const absolute = resolvePath(this.cwd, view.path as string)
      let current: string
      try {
        current = readSource(absolute)
      } catch (error) {
        this.invalidate(view, `Live source unavailable: ${errorMessage(error)}. Recovery: read(path=${quote(view.path as string)}).`)
        continue
      }
      const revision = hashText(current)
      if (revision === view.revision) continue

      const oldText = this.textForView(view)
      if (oldText === undefined) {
        this.invalidate(view, `Historical base unavailable. Recovery: read(path=${quote(view.path as string)}).`)
        continue
      }
      const relocated = relocateRange(view, parseLines(oldText), parseLines(current))
      if (relocated === undefined) {
        this.invalidate(
          view,
          `Live range changed and could not be safely relocated. Recovery: read(path=${quote(view.path as string)}).`,
        )
        continue
      }

      const fresh = this.versionDocument({
        sourceRef: view.fileRef as string,
        fileRef: view.fileRef,
        path: view.path,
        title: view.path as string,
        live: true,
        text: current,
      })
      view.versionRef = fresh.versionRef
      view.revision = fresh.revision
      view.complete = fresh.complete
      view.cursorLine = relocated
      view.cursorChar = 0
      try {
        this.render(view, fresh.text)
      } catch (error) {
        this.invalidate(view, `${errorMessage(error)}. Recovery: read(path=${quote(view.path as string)}).`)
      }
    }
  }

  private invalidate(view: View, reason: string): void {
    view.invalidReason = reason
    view.visibleAnchors.clear()
    view.visibleLines.clear()
    view.rendered = fitText(`## INVALID ${view.title}\n${reason}\n`, view.limitTokens)
    view.tokenCount = estimateTokens(view.rendered)
  }

  private textForView(view: View): string | undefined {
    try {
      const descriptor = this.store.get(view.versionRef)
      if (typeof descriptor.snapshotRef !== "string") return undefined
      return this.store.loadText(descriptor.snapshotRef).text
    } catch {
      return undefined
    }
  }

  private editByAnchors(edits: AnchorEdit[]): MemoryResult {
    if (edits.length === 0) return failure("At least one anchor edit is required")

    try {
      const anchors = edits.map((edit, index) => this.resolveAnchorEdit(edit, index))
      const first = anchors[0]
      if (!first) return failure("At least one anchor edit is required")
      if (anchors.some((entry) => entry.path !== first.path || entry.versionRef !== first.versionRef)) {
        return failure(`All anchor edits must use the same file and base revision. Recovery: read(path=${quote(first.path)}).`)
      }

      const current = readSource(resolvePath(this.cwd, first.path))
      if (hashText(current) !== first.revision) {
        return failure(`Edit base is stale. Recovery: read(path=${quote(first.path)}).`)
      }
      const lines = parseLines(current)
      const replacements = anchors.map((entry) => anchorReplacement(entry.edit, entry.points, lines, entry.index))
      const overlap = firstOverlap(replacements)
      if (overlap) return failure(`${overlap}. Recovery: read(path=${quote(first.path)}).`)
      return this.commitEdit(first.path, current, replacements)
    } catch (error) {
      const message = errorMessage(error)
      return failure(message.includes("Recovery:") ? message : `${message}. ${this.anchorRecovery(edits)}`)
    }
  }

  private anchorRecovery(edits: AnchorEdit[]): string {
    for (const edit of edits) {
      for (const ref of [edit.from, edit.through, edit.before, edit.after]) {
        if (!ref) continue
        try {
          const line = this.store.get(ref)
          if (typeof line.versionRef !== "string") continue
          const version = this.store.get(line.versionRef)
          if (typeof version.path === "string") return `Recovery: read(path=${quote(version.path)}).`
        } catch {
          // Try another supplied or resident reference.
        }
      }
    }
    const resident = [...this.views.values()].find((view) => view.live && view.path)
    return resident?.path
      ? `Recovery: read(path=${quote(resident.path)}).`
      : "Recovery: read the target path again and use its current anchors."
  }

  private resolveAnchorEdit(edit: AnchorEdit, index: number): {
    edit: AnchorEdit
    index: number
    path: string
    versionRef: string
    revision: string
    points: Record<string, number>
  } {
    const shape = anchorShape(edit)
    if (!shape) throw new Error(`Edit #${index + 1} must use from+through, before, or after exactly once`)
    const refs = shape === "range" ? [edit.from as string, edit.through as string] : [edit[shape] as string]
    let path: string | undefined
    let versionRef: string | undefined
    let revision: string | undefined
    const points: Record<string, number> = {}

    for (const [pointIndex, ref] of refs.entries()) {
      const descriptor = this.store.get(ref)
      if (descriptor.kind !== "line" || typeof descriptor.versionRef !== "string" || typeof descriptor.line !== "number") {
        throw new Error(`Edit #${index + 1} reference ${ref} is not a line anchor`)
      }
      const version = this.store.get(descriptor.versionRef)
      if (
        version.kind !== "file-version" ||
        typeof version.path !== "string" ||
        typeof version.revision !== "string"
      ) throw new Error(`Edit #${index + 1} reference ${ref} is historical or not a live file anchor`)
      const visible = [...this.views.values()].some((view) =>
        view.live && !view.invalidReason && view.versionRef === descriptor.versionRef && view.visibleAnchors.get(ref) === descriptor.line
      )
      if (!visible) {
        throw new Error(`Edit #${index + 1} reference ${ref} is stale, evicted, or not fully visible. Recovery: read(path=${quote(version.path)}).`)
      }
      if (path !== undefined && (path !== version.path || versionRef !== descriptor.versionRef)) {
        throw new Error(`Edit #${index + 1} endpoints do not share one base revision`)
      }
      path = version.path
      versionRef = descriptor.versionRef
      revision = version.revision
      points[pointIndex === 0 ? "first" : "second"] = descriptor.line
    }
    if (shape === "range") {
      const first = points.first as number
      const second = points.second as number
      if (first > second) {
        throw new Error(`Edit #${index + 1} range is reversed; from must precede through`)
      }
      const visibleLines = new Set<number>()
      for (const view of this.views.values()) {
        if (view.live && !view.invalidReason && view.versionRef === versionRef) {
          for (const line of view.visibleLines) visibleLines.add(line)
        }
      }
      for (let line = first; line <= second; line++) {
        if (!visibleLines.has(line)) {
          throw new Error(`Edit #${index + 1} range includes line ${line + 1}, which is not fully visible. Recovery: read(path=${quote(path as string)}).`)
        }
      }
    }
    return { edit, index, path: path as string, versionRef: versionRef as string, revision: revision as string, points }
  }

  private editByText(path: string, edits: OldEdit[]): MemoryResult {
    if (edits.length === 0) return failure(`At least one text edit is required. Recovery: read(path=${quote(path)}).`)
    const absolute = resolvePath(this.cwd, path)
    const display = displayPath(this.cwd, absolute)
    const existed = existsSync(absolute)
    if (!existed) {
      if (edits.length !== 1 || edits[0]?.oldText !== "") {
        return failure(`Missing file can only be created by one empty oldText edit. Recovery: read(path=${quote(display)}).`)
      }
      try {
        return this.commitEdit(display, undefined, [{ start: 0, end: 0, text: edits[0].newText, label: "Edit #1" }])
      } catch (error) {
        return failure(`${errorMessage(error)}. Recovery: read(path=${quote(display)}).`)
      }
    }

    try {
      const current = readSource(absolute)
      const revision = hashText(current)
      const liveViews = [...this.views.values()].filter((view) =>
        view.live && view.path === display && !view.invalidReason && view.revision === revision
      )
      if (liveViews.length === 0) {
        return failure(`No current visible coverage for ${display}. Recovery: read(path=${quote(display)}).`)
      }
      const visible = visibleIntervals(liveViews, parseLines(current))
      const replacements: Replacement[] = []
      for (const [index, edit] of edits.entries()) {
        if (edit.oldText.length === 0) {
          return failure(`Edit #${index + 1}: empty oldText is only valid when creating a missing file. Recovery: read(path=${quote(display)}).`)
        }
        const occurrences = findOccurrences(current, edit.oldText)
        if (occurrences.length === 0) {
          return failure(`Edit #${index + 1}: oldText was not found. Recovery: read(path=${quote(display)}).`)
        }
        if (occurrences.length > 1 && !edit.replaceAll) {
          return failure(`Edit #${index + 1}: oldText matches ${occurrences.length} times; use unique visible context or replaceAll. Recovery: read(path=${quote(display)}).`)
        }
        const selected = edit.replaceAll ? occurrences : occurrences.slice(0, 1)
        for (const start of selected) {
          const end = start + edit.oldText.length
          if (!intervalCovered(start, end, visible)) {
            return failure(`Edit #${index + 1} is outside exact visible coverage. Recovery: read(path=${quote(display)}, find=${quote(edit.oldText)}).`)
          }
          replacements.push({ start, end, text: edit.newText, label: `Edit #${index + 1}` })
        }
      }
      const overlap = firstOverlap(replacements)
      if (overlap) return failure(`${overlap}. Recovery: read(path=${quote(display)}).`)
      return this.commitEdit(display, current, replacements)
    } catch (error) {
      const message = errorMessage(error)
      return failure(message.includes("Recovery:") ? message : `${message}. Recovery: read(path=${quote(display)}).`)
    }
  }

  private commitEdit(path: string, base: string | undefined, replacements: Replacement[]): MemoryResult {
    const absolute = resolvePath(this.cwd, path)
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) return failure(`Refusing to replace a symlink: ${path}. Read and edit the resolved target path explicitly.`)
    let output = base ?? ""
    for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
      output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end)
    }

    if (!output.isWellFormed()) return failure("Replacement is not well-formed Unicode; no file was changed.")
    const pathViews = [...this.views.values()].filter((view) => view.live && view.path === path)
    const baseRevision = base === undefined ? undefined : hashText(base)
    const priorViews = pathViews.filter((view) => baseRevision === undefined || view.revision === baseRevision)
    const fileRef = this.store.put({ kind: "file", path, absolutePath: absolute })
    const loaded = this.versionDocument({ sourceRef: fileRef, fileRef, path, title: path, live: true, text: output })
    const outputLines = parseLines(loaded.text)
    const sorted = [...replacements].sort((a, b) => a.start - b.start)
    const firstOffset = sorted[0]?.start ?? 0
    const editedOutputOffset = transformOffset(firstOffset, sorted, "start")
    const editedLine = lineAtOffset(outputLines, editedOutputOffset)
    const oldLines = parseLines(base ?? "")
    const plans = priorViews.length > 0
      ? priorViews
          .sort((a, b) => Number(viewContainsReplacement(a, base ?? "", sorted)) - Number(viewContainsReplacement(b, base ?? "", sorted)))
          .map((previous) => {
            const oldStart = oldLines[previous.cursorLine]?.start ?? 0
            const transformedStart = transformOffset(oldStart + previous.cursorChar, sorted, "start")
            const affected = viewContainsReplacement(previous, base ?? "", sorted)
            return {
              affected,
              cursor: affected
                ? Math.min(lineAtOffset(outputLines, transformedStart), Math.max(0, editedLine - 2))
                : lineAtOffset(outputLines, transformedStart),
              limit: Math.min(previous.limitTokens, this.budgetTokens),
            }
          })
      : [{ affected: true, cursor: Math.max(0, editedLine - 2), limit: Math.min(DEFAULT_VIEW_BUDGET, this.budgetTokens) }]

    // Prove the post-edit view can be materialized before writing. Durable preview
    // descriptors are harmless; no unseen content is granted edit authority.
    for (const plan of plans) {
      let preview = this.previewPromotion(loaded, plan.cursor, plan.limit)
      if (plan.affected && !viewDisplaysLine(preview, editedLine)) {
        plan.cursor = Math.max(0, editedLine - 2)
        preview = this.previewPromotion(loaded, plan.cursor, plan.limit)
        if (!viewDisplaysLine(preview, editedLine)) {
          throw new Error(`Edited region cannot fit in the current view budget; increase the budget before editing`)
        }
      }
    }

    // Optimistic guard immediately before the atomic rename. A writer racing after this check can still win.
    if (base === undefined) {
      if (existsSync(absolute)) return failure(`File appeared before creation. Recovery: read(path=${quote(path)}).`)
    } else {
      let latest: string
      try {
        latest = readSource(absolute)
      } catch (error) {
        return failure(`Cannot revalidate file before edit: ${errorMessage(error)}. Recovery: read(path=${quote(path)}).`)
      }
      if (hashText(latest) !== hashText(base)) {
        return failure(`File changed before edit. Recovery: read(path=${quote(path)}).`)
      }
    }

    mkdirSync(dirname(absolute), { recursive: true })
    const temporary = `${absolute}.${randomUUID()}.stacky-tmp`
    const mode = base === undefined ? 0o600 : statSync(absolute).mode & 0o777
    try {
      writeFileSync(temporary, output, { encoding: "utf8", mode, flag: "wx" })
      chmodSync(temporary, mode)
      renameSync(temporary, absolute)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // Preserve the write failure.
      }
      throw error
    }

    for (const view of pathViews) this.views.delete(view.key)

    const evicted: string[] = []
    let promoted: View | undefined
    for (const plan of plans) {
      const result = this.promote(loaded, plan.cursor, 0, plan.limit)
      evicted.push(...result.evicted)
      promoted = result.view
    }
    if (!promoted) throw new Error("Edited view plan was unexpectedly empty")
    return {
      ok: true,
      message: `Edited ${path} at guarded base; loaded version ${promoted.versionRef} (post-check external races remain possible).`,
      ref: loaded.fileRef,
      outputRef: this.store.get(promoted.versionRef).snapshotRef as string,
      evicted,
    }
  }

  private previewPromotion(loaded: LoadedDocument, cursorLine: number, limitTokens: number): View {
    const resident = this.views
    const clock = this.clock
    const stableCounter = this.stableCounter
    this.views = new Map([...resident].filter(([, view]) => view.pinned && view.path !== loaded.path))
    try {
      return this.promote(loaded, cursorLine, 0, limitTokens).view
    } finally {
      this.views = resident
      this.clock = clock
      this.stableCounter = stableCounter
    }
  }

  private evictToBudget(protectedKey?: string): string[] {
    const evicted: string[] = []
    while (this.totalTokens() > this.budgetTokens && this.views.size > 0) {
      const candidates = [...this.views.values()]
        .filter((view) => !view.pinned && (view.key !== protectedKey || ![...this.views.values()].some((other) => !other.pinned && other.key !== protectedKey)))
        .sort((a, b) => a.lastUsed - b.lastUsed || a.stableIndex - b.stableIndex)
      const victim = candidates[0]
      if (!victim) break
      this.views.delete(victim.key)
      evicted.push(this.viewLabel(victim))
    }
    return evicted
  }

  private combinedRendered(): string {
    const scopeDepth = (view: View) => Math.min(...[...(this.instructionScopes.get(resolvePath(this.cwd, view.path!)) ?? [])].map((scope) => scope.split("/").length))
    const pins = [...this.views.values()].filter((view) => view.pinned)
      .sort((a, b) => scopeDepth(a) - scopeDepth(b) || a.path!.localeCompare(b.path!))
    const pinnedText = pins.map((view) => view.rendered).join("\n")
    const warning = estimateTokens(pinnedText) > this.budgetTokens
      ? "[Pinned AGENTS.md instructions exceed the working-view budget; instructions are retained in full. Increase the budget for other views.]\n" : ""
    return warning + [...pins, ...[...this.views.values()].filter((view) => !view.pinned).sort((a, b) => a.stableIndex - b.stableIndex)]
      .map((view) => view.rendered).join("\n")
  }

  private viewLabel(view: View): string {
    if (view.live) {
      return `read({ref:${quote(view.fileRef ?? view.sourceRef)}})`
    }
    return `read({ref:${quote(this.pageRef(view, view.cursorLine, view.cursorChar))}})`
  }
}

function parseLines(text: string): ParsedLine[] {
  const lines: ParsedLine[] = []
  const pattern = /\r\n|\n|\r/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    lines.push({ text: text.slice(start, match.index), start, contentEnd: match.index, end: pattern.lastIndex, newline: match[0] })
    start = pattern.lastIndex
  }
  if (start < text.length || lines.length === 0) {
    lines.push({ text: text.slice(start), start, contentEnd: text.length, end: text.length, newline: "" })
  }
  return lines
}

function anchorShape(edit: AnchorEdit): "range" | "before" | "after" | undefined {
  const range = edit.from !== undefined || edit.through !== undefined
  if (range && edit.from !== undefined && edit.through !== undefined && edit.before === undefined && edit.after === undefined) return "range"
  if (!range && edit.before !== undefined && edit.after === undefined) return "before"
  if (!range && edit.after !== undefined && edit.before === undefined) return "after"
  return undefined
}

function anchorReplacement(edit: AnchorEdit, points: Record<string, number>, lines: ParsedLine[], index: number): Replacement {
  const shape = anchorShape(edit)
  const first = points.first
  if (shape === undefined || first === undefined || !lines[first]) throw new Error(`Edit #${index + 1} has an invalid anchor`)
  if (shape === "range") {
    const second = points.second
    if (second === undefined || !lines[second]) throw new Error(`Edit #${index + 1} has an invalid through anchor`)
    if (first > second) throw new Error(`Edit #${index + 1} range is reversed; from must precede through`)
    const target = lines[second] as ParsedLine
    const text = edit.text.length > 0 && target.newline && !endsWithNewline(edit.text) ? edit.text + target.newline : edit.text
    return { start: (lines[first] as ParsedLine).start, end: target.end, text, label: `Edit #${index + 1}` }
  }
  const target = lines[first] as ParsedLine
  if (shape === "before") {
    const newline = target.newline || "\n"
    const text = edit.text.length > 0 && !endsWithNewline(edit.text) ? edit.text + newline : edit.text
    return { start: target.start, end: target.start, text, label: `Edit #${index + 1}` }
  }
  const newline = target.newline || "\n"
  const text = edit.text.length === 0
    ? ""
    : target.newline
      ? (endsWithNewline(edit.text) ? edit.text : edit.text + newline)
      : (startsWithNewline(edit.text) ? edit.text : newline + edit.text)
  return { start: target.end, end: target.end, text, label: `Edit #${index + 1}` }
}

function visibleIntervals(views: View[], lines: ParsedLine[]): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = []
  for (const view of views) {
    for (const lineIndex of view.visibleLines) {
      const line = lines[lineIndex]
      if (line) intervals.push({ start: line.start, end: line.end })
    }
  }
  intervals.sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

function intervalCovered(start: number, end: number, intervals: Array<{ start: number; end: number }>): boolean {
  return intervals.some((interval) => start >= interval.start && end <= interval.end)
}

function findOccurrences(text: string, needle: string): number[] {
  const found: number[] = []
  let offset = 0
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    found.push(offset)
    offset += Math.max(1, needle.length)
  }
  return found
}

function firstOverlap(replacements: Replacement[]): string | undefined {
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1] as Replacement
    const current = sorted[index] as Replacement
    const previousInsert = previous.start === previous.end
    const currentInsert = current.start === current.end
    const insertsCoincide = previousInsert && currentInsert && previous.start === current.start
    const insertionTouchesRange = previousInsert !== currentInsert && (
      previousInsert
        ? previous.start >= current.start && previous.start <= current.end
        : current.start >= previous.start && current.start <= previous.end
    )
    if (current.start < previous.end || insertsCoincide || insertionTouchesRange) {
      return `${previous.label} overlaps ${current.label}; no changes were written`
    }
  }
  return undefined
}

function relocateRange(view: View, oldLines: ParsedLine[], newLines: ParsedLine[]): number | undefined {
  if (view.coveredWholeDocument) return 0
  const before = view.beforeContext
  const after = view.afterContext
  const beforeMatches = before === undefined ? [] : matchingLines(newLines, before)
  const afterMatches = after === undefined ? [] : matchingLines(newLines, after)

  if (before !== undefined && after !== undefined) {
    if (beforeMatches.length !== 1 || afterMatches.length !== 1 || (beforeMatches[0] as number) >= (afterMatches[0] as number)) return undefined
    return (beforeMatches[0] as number) + 1
  }
  if (before !== undefined) return beforeMatches.length === 1 ? (beforeMatches[0] as number) + 1 : undefined
  if (after !== undefined) return afterMatches.length === 1 ? 0 : undefined

  // Empty documents are safe to reopen at their beginning.
  return oldLines.length === 1 && oldLines[0]?.text === "" ? 0 : undefined
}

function matchingLines(lines: ParsedLine[], text: string): number[] {
  const matches: number[] = []
  for (const [index, line] of lines.entries()) if (line.text === text) matches.push(index)
  return matches
}

function lineAtOffset(lines: ParsedLine[], offset: number): number {
  const index = lines.findIndex((line) => offset < line.end || (line.end === line.start && offset === line.start))
  return index < 0 ? Math.max(0, lines.length - 1) : index
}

function readSource(path: string): string {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error(`Not a regular file within the 64 MiB read limit: ${path}`)
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path)) }
  catch (error) {
    if (error instanceof TypeError) throw new Error(`File is not valid UTF-8 text: ${path}. Use a bounded binary-aware shell command instead.`)
    throw error
  }
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute
}

function normalizeBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BUDGET
  return Math.max(0, Math.floor(value))
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function fitText(text: string, tokens: number): string {
  if (tokens <= 0) return ""
  let output = text.slice(0, tokens * 4)
  while (estimateTokens(output) > tokens) output = output.slice(0, -1)
  return output
}

function safeCodePointStart(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(text.length, index))
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index
}

function codePointEnds(text: string, start: number, maximumUnits: number): number[] {
  const ends: number[] = []
  let index = safeCodePointStart(text, start)
  const maximumEnd = Math.min(text.length, index + Math.max(1, maximumUnits))
  while (index < text.length && index < maximumEnd) {
    const code = text.codePointAt(index)
    index += code !== undefined && code > 0xffff ? 2 : 1
    ends.push(index)
  }
  return ends
}

function displayedRangesOverlap(first: View, second: View): boolean {
  const firstStart: [number, number] = [first.cursorLine, first.cursorChar]
  const secondStart: [number, number] = [second.cursorLine, second.cursorChar]
  const firstEnd = displayedEnd(first)
  const secondEnd = displayedEnd(second)
  return comparePosition(firstStart, secondEnd) < 0 && comparePosition(secondStart, firstEnd) < 0
}

function displayedEnd(view: View): [number, number] {
  if (view.atEnd) return [Number.MAX_SAFE_INTEGER, 0]
  return view.endChar > 0 ? [view.endLine, view.endChar] : [view.endLine + 1, 0]
}

function comparePosition(first: [number, number], second: [number, number]): number {
  return first[0] - second[0] || first[1] - second[1]
}

function viewDisplaysLine(view: View, line: number): boolean {
  return view.visibleLines.has(line) ||
    (view.endChar > 0 && view.endLine === line) ||
    (view.cursorChar > 0 && view.cursorLine === line && comparePosition([line, view.cursorChar], displayedEnd(view)) < 0)
}

function viewContainsReplacement(view: View, text: string, replacements: Replacement[]): boolean {
  const lines = parseLines(text)
  const start = (lines[view.cursorLine]?.start ?? 0) + view.cursorChar
  const endLine = lines[view.endLine]
  const end = view.endChar > 0
    ? (endLine?.start ?? text.length) + view.endChar
    : endLine?.end ?? text.length
  return replacements.some((replacement) => replacement.start <= end && replacement.end >= start)
}

function transformOffset(offset: number, replacements: Replacement[], side: "start" | "end"): number {
  let delta = 0
  for (const replacement of replacements) {
    if (offset < replacement.start) break
    if (offset <= replacement.end) {
      return replacement.start + delta + (side === "end" ? replacement.text.length : 0)
    }
    delta += replacement.text.length - (replacement.end - replacement.start)
  }
  return offset + delta
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function failure(message: string): MemoryResult {
  return { ok: false, message, evicted: [] }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function endsWithNewline(text: string): boolean {
  return /(?:\r\n|\n|\r)$/.test(text)
}

function startsWithNewline(text: string): boolean {
  return /^(?:\r\n|\n|\r)/.test(text)
}

function isExportedView(value: unknown): value is ExportedView {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<ExportedView>
  return (item.kind === "live" || item.kind === "historical") &&
    typeof item.line === "number" && typeof item.char === "number" && typeof item.limitTokens === "number"
}
