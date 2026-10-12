import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { estimateTokens } from "../agent/conversation.ts"
import { MemoryStore } from "./store.ts"

const DEFAULT_BUDGET = 24_000
const MIN_VIEW_TOKENS = 24
const CONTINUATION_RESERVE = 26

export type MemoryResult = {
  ok: boolean
  message: string
  ref?: string
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

/** Reference-addressed, hard-token-bounded working views. */
export class WorkspaceMemory {
  readonly store: MemoryStore
  readonly cwd: string
  budgetTokens: number
  private readonly resolveDocument?: WorkspaceMemoryOptions["resolveDocument"]
  private views = new Map<string, View>()
  private clock = 0
  private stableCounter = 0

  constructor(options: WorkspaceMemoryOptions) {
    this.cwd = resolve(options.cwd)
    this.store = options.store
    this.budgetTokens = normalizeBudget(options.budgetTokens ?? DEFAULT_BUDGET)
    this.resolveDocument = options.resolveDocument
  }

  read(input: { path?: string; ref?: string; find?: string; budgetTokens?: number } | string): MemoryResult {
    const request = typeof input === "string" ? { path: input } : input
    if ((request.path === undefined) === (request.ref === undefined)) {
      return failure("Provide exactly one of path or ref")
    }
    const limit = Math.min(this.budgetTokens, normalizeBudget(request.budgetTokens ?? this.budgetTokens))
    if (limit < MIN_VIEW_TOKENS) {
      return failure(`View budget must be at least ${MIN_VIEW_TOKENS} tokens`)
    }

    try {
      const loaded = request.path !== undefined
        ? this.loadLivePath(request.path)
        : this.loadReference(request.ref as string, request.find)
      if (!loaded) return failure(`Reference ${request.ref} is not readable. Recovery: verify the exact ref.`)

      let cursorLine = loaded.startLine ?? 0
      let cursorChar = loaded.startChar ?? 0
      if (request.find !== undefined && request.find.length > 0 && !loaded.searched) {
        const found = loaded.text.indexOf(request.find)
        if (found < 0) {
          return failure(
            `Literal text not found in ${loaded.title}. Recovery: read(${loaded.live ? `path=${quote(loaded.path ?? loaded.title)}` : `ref=${quote(loaded.sourceRef)}`}).`,
          )
        }
        const lines = parseLines(loaded.text)
        cursorLine = lineAtOffset(lines, found)
        const line = lines[cursorLine]
        const offsetInLine = found - (line?.start ?? found)
        cursorChar = estimateTokens(line?.text ?? "") > Math.max(MIN_VIEW_TOKENS, limit - CONTINUATION_RESERVE)
          ? Math.max(0, offsetInLine - 24)
          : 0
      }
      const { view, evicted } = this.promote(loaded, cursorLine, cursorChar, limit)
      return {
        ok: true,
        message: `Loaded ${loaded.title} as ${view.versionRef}${view.atEnd ? "" : "; continuation is in working context"}.`,
        ref: loaded.live ? loaded.fileRef : loaded.sourceRef,
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
    const loaded = this.loadImmutableText(ref, descriptor.text, descriptor.title, descriptor.omittedBytes === 0)
    const { view, evicted } = this.promote(loaded, 0, 0, this.budgetTokens)
    return {
      ok: true,
      message: `Captured ${meta.title} as ${ref}${view.atEnd ? "" : "; continuation is in working context"}.`,
      ref,
      evicted,
    }
  }

  edit(input: { edits: AnchorEdit[] } | { path: string; edits: OldEdit[] }): MemoryResult {
    if ("path" in input) return this.editByText(input.path, input.edits)
    return this.editByAnchors(input.edits)
  }

  /** Refreshes live ranges without touching recency, then renders stable-order views. */
  materialize(): string {
    this.refreshLiveViews()
    this.evictToBudget()
    return [...this.views.values()]
      .sort((a, b) => a.stableIndex - b.stableIndex)
      .map((view) => view.rendered)
      .join("\n")
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
    let total = 0
    for (const view of this.views.values()) total += view.tokenCount
    return total
  }

  setBudget(tokens: number): string[] {
    this.budgetTokens = normalizeBudget(tokens)
    if (this.budgetTokens < MIN_VIEW_TOKENS) {
      const receipts = [...this.views.values()].map(viewLabel)
      this.views.clear()
      return receipts
    }
    for (const view of this.views.values()) {
      if (view.limitTokens > this.budgetTokens) {
        view.limitTokens = this.budgetTokens
        const text = this.textForView(view)
        if (text !== undefined) this.render(view, text)
      }
    }
    return this.evictToBudget()
  }

  clear(): void {
    this.views.clear()
  }

  restorePaths(paths: string[]): void {
    this.clear()
    for (const path of paths) this.read({ path })
  }

  exportViews(): unknown[] {
    return [...this.views.values()].map((view): ExportedView => view.live && view.path
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
          ref: this.pageRef(view.versionRef, view.cursorLine, view.cursorChar, view.title),
          line: view.cursorLine,
          char: view.cursorChar,
          limitTokens: view.limitTokens,
        })
  }

  restoreViews(values: unknown[]): void {
    this.clear()
    if (!Array.isArray(values)) return
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
          if (savedVersion.revision !== loaded.revision) continue
        }
        this.promote(
          loaded,
          value.kind === "live" ? value.line : (loaded.startLine ?? 0),
          value.kind === "live" ? value.char : (loaded.startChar ?? 0),
          Math.min(this.budgetTokens, normalizeBudget(value.limitTokens)),
        )
      } catch {
        // Restore is best-effort. Missing exact refs remain missing rather than being guessed.
      }
    }
  }

  private loadLivePath(path: string): LoadedDocument {
    const absolute = resolvePath(this.cwd, path)
    const shownPath = displayPath(this.cwd, absolute)
    const stat = statSync(absolute)
    if (!stat.isFile()) throw new Error(`Path is not a file: ${shownPath}`)
    const text = readFileSync(absolute, "utf8")
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

    if (descriptor.kind === "file" && typeof descriptor.path === "string") {
      return this.loadLivePath(typeof descriptor.absolutePath === "string" ? descriptor.absolutePath : descriptor.path)
    }
    if (descriptor.kind === "text") {
      const artifact = this.store.loadText(ref)
      return this.loadImmutableText(ref, artifact.text, artifact.title, artifact.omittedBytes === 0)
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
      return { ...this.loadVersion(descriptor.versionRef), startLine: descriptor.line, startChar: descriptor.char }
    }

    const resolved = this.resolveDocument?.(ref, find)
    if (!resolved) return undefined
    return { ...this.loadImmutableText(ref, resolved.text, resolved.title), searched: resolved.searched }
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
    return { ...input, versionRef, revision, complete }
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
    const lines = parseLines(loaded.text)
    const safeLine = Math.max(0, Math.min(lines.length - 1, cursorLine))
    const safeChar = Math.max(0, Math.min(lines[safeLine]?.text.length ?? 0, cursorChar))

    // Exact and contained reads reuse one view rather than duplicating overlapping content.
    const reusable = [...this.views.values()].find((view) =>
      view.versionRef === loaded.versionRef &&
      !view.invalidReason &&
      safeChar === 0 &&
      view.cursorChar === 0 &&
      safeLine >= view.cursorLine &&
      safeLine <= view.endLine
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
    }
    this.render(view, loaded.text)
    this.views.set(view.key, view)
    return { view, evicted: this.evictToBudget(view.key) }
  }

  private render(view: View, text: string): void {
    const lines = parseLines(text)
    view.visibleAnchors.clear()
    view.visibleLines.clear()
    view.invalidReason = undefined
    view.cursorLine = Math.max(0, Math.min(lines.length - 1, view.cursorLine))
    const source = view.live ? `LIVE ${view.path ?? view.title}` : `READ-ONLY ${view.title}`
    let rendered = `## ${source} ref=${view.sourceRef} version=${view.versionRef}\n`
    if (!view.complete) rendered += "[snapshot partial: omitted bytes are unavailable]\n"
    if (estimateTokens(rendered) >= view.limitTokens - CONTINUATION_RESERVE) {
      rendered = fitText(`ref=${view.sourceRef} version=${view.versionRef}\n`, view.limitTokens - CONTINUATION_RESERVE)
    }

    let lineIndex = view.cursorLine
    let charIndex = view.cursorChar
    let stopped = false
    while (lineIndex < lines.length) {
      const line = lines[lineIndex]
      if (!line) break
      if (charIndex > 0) {
        const prefix = `[fragment line ${lineIndex + 1} chars ${charIndex + 1}- read-only] `
        const room = Math.max(0, (view.limitTokens - CONTINUATION_RESERVE - estimateTokens(rendered + prefix)) * 4)
        if (room <= 0) {
          stopped = true
          break
        }
        const piece = line.text.slice(charIndex, charIndex + room)
        rendered += `${prefix}${piece}\n`
        charIndex += piece.length
        if (charIndex < line.text.length) {
          stopped = true
          break
        }
        lineIndex += 1
        charIndex = 0
        continue
      }

      const anchor = this.store.put({ kind: "line", versionRef: view.versionRef, line: lineIndex })
      const record = `[${anchor}|${lineIndex + 1}] ${line.text}\n`
      if (estimateTokens(rendered + record) <= view.limitTokens - CONTINUATION_RESERVE) {
        rendered += record
        view.visibleAnchors.set(anchor, lineIndex)
        view.visibleLines.add(lineIndex)
        lineIndex += 1
        continue
      }

      const fragmentPrefix = `[fragment line ${lineIndex + 1} chars 1- read-only] `
      const room = Math.max(0, (view.limitTokens - CONTINUATION_RESERVE - estimateTokens(rendered + fragmentPrefix)) * 4)
      if (room > 0) {
        const piece = line.text.slice(0, room)
        rendered += `${fragmentPrefix}${piece}\n`
        charIndex = piece.length
        if (charIndex >= line.text.length) {
          lineIndex += 1
          charIndex = 0
        }
      }
      stopped = true
      break
    }

    const atPhysicalEnd = lineIndex >= lines.length
    if (!atPhysicalEnd) {
      const next = this.pageRef(view.versionRef, lineIndex, charIndex, view.title)
      const footer = `Next: read(ref=${quote(next)})\n`
      while (estimateTokens(rendered + footer) > view.limitTokens && rendered.length > 0) {
        rendered = rendered.slice(0, Math.max(0, rendered.length - 4))
      }
      rendered += footer
    } else if (!view.complete) {
      const footer = "[capture quota reached; omitted bytes are unavailable]\n"
      while (estimateTokens(rendered + footer) > view.limitTokens && rendered.length > 0) {
        rendered = rendered.slice(0, Math.max(0, rendered.length - 4))
      }
      rendered += footer
    }
    if (estimateTokens(rendered) > view.limitTokens) rendered = fitText(rendered, view.limitTokens)

    view.rendered = rendered
    view.tokenCount = estimateTokens(rendered)
    view.endLine = Math.min(lines.length - 1, charIndex > 0 ? lineIndex : Math.max(view.cursorLine, lineIndex - 1))
    view.endChar = charIndex
    view.atEnd = atPhysicalEnd
    view.coveredWholeDocument = view.cursorLine === 0 && view.cursorChar === 0 && atPhysicalEnd
    view.beforeContext = view.cursorLine > 0 ? lines[view.cursorLine - 1]?.text : undefined
    const afterIndex = lineIndex + (charIndex > 0 ? 1 : 0)
    view.afterContext = afterIndex < lines.length ? lines[afterIndex]?.text : undefined
    if (stopped && view.visibleLines.size === 0 && charIndex === 0) {
      // The continuation remains the only safe way to advance under an unusually small budget.
      view.coveredWholeDocument = false
    }
  }

  private pageRef(versionRef: string, line: number, char: number, title: string): string {
    return this.store.put({ kind: "page", versionRef, line, char, title })
  }

  private refreshLiveViews(): void {
    const live = [...this.views.values()].filter((view) => view.live && view.path)
    for (const view of live) {
      const absolute = resolvePath(this.cwd, view.path as string)
      let current: string
      try {
        current = readFileSync(absolute, "utf8")
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
      this.render(view, current)
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
    this.refreshLiveViews()

    try {
      const anchors = edits.map((edit, index) => this.resolveAnchorEdit(edit, index))
      const first = anchors[0]
      if (!first) return failure("At least one anchor edit is required")
      if (anchors.some((entry) => entry.path !== first.path || entry.versionRef !== first.versionRef)) {
        return failure(`All anchor edits must use the same file and base revision. Recovery: read(path=${quote(first.path)}).`)
      }

      const current = readFileSync(resolvePath(this.cwd, first.path), "utf8")
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
    return { edit, index, path: path as string, versionRef: versionRef as string, revision: revision as string, points }
  }

  private editByText(path: string, edits: OldEdit[]): MemoryResult {
    if (edits.length === 0) return failure(`At least one text edit is required. Recovery: read(path=${quote(path)}).`)
    this.refreshLiveViews()
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
      const current = readFileSync(absolute, "utf8")
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
    let output = base ?? ""
    for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
      output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end)
    }

    // Optimistic guard immediately before the atomic rename. A writer racing after this check can still win.
    if (base === undefined) {
      if (existsSync(absolute)) return failure(`File appeared before creation. Recovery: read(path=${quote(path)}).`)
    } else {
      let latest: string
      try {
        latest = readFileSync(absolute, "utf8")
      } catch {
        return failure(`File disappeared before edit. Recovery: read(path=${quote(path)}).`)
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

    for (const [key, view] of this.views) {
      if (view.live && view.path === path) this.views.delete(key)
    }
    const loaded = this.loadLivePath(path)
    const firstOffset = replacements.reduce((minimum, item) => Math.min(minimum, item.start), Number.POSITIVE_INFINITY)
    const cursor = Number.isFinite(firstOffset) ? lineAtOffset(parseLines(output), firstOffset) : 0
    const { view, evicted } = this.promote(loaded, cursor, 0, this.budgetTokens)
    return {
      ok: true,
      message: `Edited ${path} at guarded base; loaded version ${view.versionRef} (post-check external races remain possible).`,
      ref: loaded.fileRef,
      evicted,
    }
  }

  private evictToBudget(protectedKey?: string): string[] {
    const evicted: string[] = []
    while (this.totalTokens() > this.budgetTokens && this.views.size > 0) {
      const candidates = [...this.views.values()]
        .filter((view) => view.key !== protectedKey || this.views.size === 1)
        .sort((a, b) => a.lastUsed - b.lastUsed || a.stableIndex - b.stableIndex)
      const victim = candidates[0]
      if (!victim) break
      this.views.delete(victim.key)
      evicted.push(viewLabel(victim))
    }
    return evicted
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
    const low = Math.min(first, second)
    const high = Math.max(first, second)
    const target = lines[high] as ParsedLine
    const text = edit.text.length > 0 && target.newline && !endsWithNewline(edit.text) ? edit.text + target.newline : edit.text
    return { start: (lines[low] as ParsedLine).start, end: target.end, text, label: `Edit #${index + 1}` }
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

function viewLabel(view: View): string {
  return view.live && view.path ? `${view.path}@${view.versionRef}` : `${view.title}@${view.versionRef}`
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
