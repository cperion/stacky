import type { ClosedFrame, TaskFrame } from "../agent/types.ts"
import type { MemoryStore } from "./store.ts"

export type HistoryDocument = {
  text: string
  title: string
  searched?: boolean
}

type StoredEvent = { ref: string; value: Record<string, unknown> }
type EventFilter = {
  agentId?: string
  frameId?: string
  type?: string
  query?: string
  parentId?: string | null
  after?: number
  before?: number
  through?: number
  order?: "asc" | "desc"
  limit?: number
}

type CollectionScope = "agent" | "frame" | "children"

type Scope = {
  scope: CollectionScope
  agentId: string
  frameId?: string
  parentId?: string
  /** The first sequence number in the immutable scope (exclusive). */
  lowerBound: number
  /** The last sequence number in the immutable scope (inclusive). */
  through: number
}

type FrameDetails = {
  frame?: TaskFrame
  frameRef?: string
  parentId?: string
  parentRef?: string
  opened?: StoredEvent
  closed?: StoredEvent
}

const SCAN_BATCH = 200
const EVENTS_PER_PAGE = 12
const SEARCH_RESULTS_PER_PAGE = 20
const EVENT_CHARS_PER_PAGE = 10_000
const MAX_DOCUMENT_CHARS = 14_000
const MAX_SUMMARY_CHARS = 360
const MAX_CONTEXT_CHARS = 4_000
const CONTEXT_RELATION_QUERY_LIMIT = 8

/**
 * Durable, reference-addressed navigation over one agent's task history.
 *
 * Frame resource references are stable. Event, page, and search references are
 * immutable descriptors stored by MemoryStore, so following a continuation can
 * never drift into events appended after the original read.
 */
export class FrameHistory {
  readonly rootRef: string

  private readonly store: MemoryStore
  private readonly agentId: string
  private readonly knownFrameRefs = new Map<string, string>()

  constructor(store: MemoryStore, agentId: string) {
    this.store = store
    this.agentId = agentId
    this.rootRef = store.put({ kind: "history.root", agentId })
  }

  /** Return the stable resource reference for a frame owned by this agent. */
  ref(frameId: string): string {
    const ref = this.store.put({ kind: "history.frame", agentId: this.agentId, frameId })
    this.knownFrameRefs.set(frameId, ref)
    return ref
  }

  /** Archive a frame before it becomes active and return its stable resource ref. */
  open(
    frame: TaskFrame,
    parentId?: string,
    opts?: { spawnedFrom?: string; resume?: string },
  ): string {
    const frameRef = this.ref(frame.id)
    const parentRef = parentId === undefined ? this.rootRef : this.ref(parentId)
    const payload: Record<string, unknown> = {
      frame: snapshot(frame),
      frameRef,
      parentId: parentId ?? null,
      parentRef,
    }
    if (opts?.spawnedFrom !== undefined) payload.spawnedFrom = opts.spawnedFrom
    if (opts?.resume !== undefined) payload.resume = opts.resume

    this.event("frame.open", payload, frame.id)
    return frameRef
  }

  /** Record an immutable snapshot of mutable frame state (for example TODOs). */
  update(frame: TaskFrame): void {
    const frameRef = this.ref(frame.id)
    const ownership = this.findOwnership(this.agentId, frame.id)
    this.event(
      "frame.update",
      {
        frame: snapshot(frame),
        frameRef,
        parentId: ownership?.parentId ?? null,
        parentRef: ownership?.parentRef ?? this.rootRef,
      },
      frame.id,
    )
  }

  /**
   * Archive a terminal frame snapshot. Large human-facing return fields also get
   * individual artifact refs, while the event retains the exact close payload.
   */
  close(frame: ClosedFrame): string {
    const frameId = frame.intent.id
    const frameRef = this.ref(frameId)
    const ownership = this.findOwnership(this.agentId, frameId)
    const title = frame.intent.title || frameId
    const reportRef = this.store.text(frame.disposition.whatWasDone, {
      title: `${title} · report`,
      kind: "frame.report",
      agentId: this.agentId,
      frameId,
    })
    const evidenceRef = this.store.text(frame.disposition.evidence, {
      title: `${title} · evidence`,
      kind: "frame.evidence",
      agentId: this.agentId,
      frameId,
    })
    const parentEffectRef = this.store.text(frame.disposition.effectsOnParent, {
      title: `${title} · parent effects`,
      kind: "frame.parent-effects",
      agentId: this.agentId,
      frameId,
    })

    return this.event(
      "frame.close",
      {
        closed: snapshot(frame),
        frameRef,
        parentId: ownership?.parentId ?? null,
        parentRef: ownership?.parentRef ?? this.rootRef,
        reportRef,
        evidenceRef,
        parentEffectRef,
      },
      frameId,
    )
  }

  /** Archive an observable turn/action/result with its exact supplied payload. */
  event(type: string, payload: unknown, frameId?: string): string {
    const archivedPayload = snapshot(payload)
    const value: Record<string, unknown> = {
      type,
      agentId: this.agentId,
      payload: archivedPayload,
    }
    if (frameId !== undefined) value.frameId = frameId
    // Keep the payload exact while exposing lifecycle ownership as indexed event
    // metadata. Stores can populate or migrate parent indexes without parsing
    // every event during a navigation query.
    if (isRecord(archivedPayload)) {
      const parentId = archivedPayload.parentId
      if (typeof parentId === "string" || parentId === null) value.parentId = parentId
    }
    return this.store.record(value)
  }

  /**
   * Resolve history resources into bounded, read-only documents. Foreign-agent
   * resources work because every descriptor carries its owning agent id.
   */
  resolve(ref: string, find?: string): HistoryDocument | undefined {
    let descriptor: Record<string, unknown>
    try {
      descriptor = this.store.get(ref)
    } catch {
      return undefined
    }

    const kind = stringField(descriptor, "kind")
    if (!isHistoryKind(kind)) return undefined

    if (find !== undefined) {
      const scope = this.scopeForDescriptor(ref, descriptor)
      if (!scope) return undefined
      return this.renderSearch(scope, find, scope.lowerBound)
    }

    switch (kind) {
      case "history.root":
        return this.renderRoot(ref, descriptor)
      case "history.frame":
        return this.renderFrame(ref, descriptor)
      case "event":
        return this.renderEvent(ref, descriptor, 0)
      case "history.page":
        return this.renderPage(descriptor)
      case "history.search":
        return this.renderStoredSearch(descriptor)
      case "history.event-page":
        return this.renderStoredEventPage(descriptor)
    }
  }

  /**
   * Render a deliberately small local navigation map. This only reads the
   * archive: it never creates refs, pages, events, or artifacts.
   */
  context(stack: readonly TaskFrame[]): string {
    const activeIds = new Set(stack.map((frame) => frame.id))
    const lines = [
      `History: ${this.rootRef}`,
      `Local task map for ${oneLine(this.agentId, 160)} (history refs are read-only):`,
    ]

    // The prompt map has fixed-size queries: its cost does not grow with the
    // archived session. Per-frame lookups also make restart recovery possible
    // without manufacturing descriptor refs during prompt rendering.
    const shownStack = stack.slice(-6)
    const openById = new Map<string, StoredEvent>()
    for (const frame of shownStack) {
      const opened = this.latestEvent({
        agentId: this.agentId,
        frameId: frame.id,
        type: "frame.open",
      })
      if (opened) openById.set(frame.id, opened)
    }

    if (stack.length > shownStack.length) {
      lines.push(`- … ${stack.length - shownStack.length} older active frame(s)`)
    }
    for (const frame of shownStack) {
      const frameRef = this.frameRefWithoutWriting(frame.id, openById.get(frame.id))
      lines.push(`- active ${oneLine(frame.title || frame.id, 120)} — ${frameRef ?? "(not archived)"}`)
    }

    const current = stack.at(-1)
    if (current) {
      const children = this.store.events({
        agentId: this.agentId,
        type: "frame.open",
        parentId: current.id,
        order: "desc",
        limit: 3,
      })
      if (children.length > 0) {
        lines.push("Recent children:")
        for (const child of children) {
          const childId = stringField(child.value, "frameId")
          const closed = childId === undefined
            ? undefined
            : this.latestEvent({ agentId: this.agentId, frameId: childId, type: "frame.close" })
          lines.push(this.contextFrameLine(child, "child", closed))
        }
      }

      const currentOpen = openById.get(current.id)
      const archivedParent = currentOpen && eventParentId(currentOpen)
      const parentId = archivedParent !== undefined ? archivedParent : stack.at(-2)?.id ?? null
      const siblings = this.store.events({
        agentId: this.agentId,
        type: "frame.close",
        parentId,
        order: "desc",
        limit: CONTEXT_RELATION_QUERY_LIMIT,
      }).filter((entry) => {
        const id = stringField(entry.value, "frameId")
        return id !== undefined && id !== current.id && !activeIds.has(id)
      }).slice(0, 3)
      if (siblings.length > 0) {
        lines.push("Recently closed siblings:")
        for (const sibling of siblings) {
          lines.push(this.contextFrameLine(sibling, "sibling"))
        }
      }
    }

    const text = lines.join("\n")
    return text.length <= MAX_CONTEXT_CHARS
      ? text
      : `${text.slice(0, MAX_CONTEXT_CHARS - 42)}\n… local map clipped; read ${this.rootRef}`
  }

  private renderRoot(ref: string, descriptor: Record<string, unknown>): HistoryDocument | undefined {
    const agentId = stringField(descriptor, "agentId")
    if (agentId === undefined) return undefined
    const through = this.latestSequence({ agentId })
    const scope: Scope = { scope: "agent", agentId, lowerBound: 0, through }
    const page = this.collectionPage(scope, 0, EVENTS_PER_PAGE)
    const lines = [
      `# Agent history · ${oneLine(agentId, 180)}`,
      `Reference: ${ref}`,
      "Scope: this agent only. Every event below names its exact owner; frame-owned turns are not folded into parent frames.",
      "Oldest events are shown first.",
      "",
      ...page.lines,
    ]
    if (page.nextAfter !== undefined) {
      const nextRef = this.pageRef(scope, page.nextAfter)
      lines.push("", `Continue: ${nextRef}`)
    }
    return boundedDocument(lines, `History · ${oneLine(agentId, 180)}`)
  }

  private renderFrame(ref: string, descriptor: Record<string, unknown>): HistoryDocument | undefined {
    const agentId = stringField(descriptor, "agentId")
    const frameId = stringField(descriptor, "frameId")
    if (agentId === undefined || frameId === undefined) return undefined

    const details = this.frameDetails(agentId, frameId)
    const title = oneLine(details.frame?.title || frameId, 180)
    const through = this.latestSequence({ agentId, frameId })
    const eventScope: Scope = { scope: "frame", agentId, frameId, lowerBound: 0, through }
    const eventPage = this.collectionPage(eventScope, 0, EVENTS_PER_PAGE)
    const childThrough = this.latestSequence({ agentId, type: "frame.open", parentId: frameId })
    const childScope: Scope = {
      scope: "children",
      agentId,
      parentId: frameId,
      lowerBound: 0,
      through: childThrough,
    }
    const childPage = this.collectionPage(childScope, 0, 6)

    const lines = [
      `# Frame · ${title}`,
      `Reference: ${ref}`,
      `Owner: ${oneLine(agentId, 180)}`,
      `Frame ID: ${oneLine(frameId, 180)}`,
    ]
    if (details.parentRef) lines.push(`Parent: ${details.parentRef}`)
    if (details.frame) {
      lines.push(`Intent: ${oneLine(details.frame.why, 400)}`)
      lines.push(`Scope: ${oneLine(details.frame.scope, 300)}`)
    }
    if (details.closed) {
      const outcome = closeOutcome(details.closed) ?? "closed"
      lines.push(`Outcome: ${outcome}`)
      const closePayload = recordField(details.closed.value, "payload")
      for (const [label, field] of [
        ["Report", "reportRef"],
        ["Evidence", "evidenceRef"],
        ["Parent effects", "parentEffectRef"],
      ] as const) {
        const value = closePayload && stringField(closePayload, field)
        if (value) lines.push(`${label}: ${value}`)
      }
    }

    lines.push("", "## Events owned by this frame only (descendants excluded)", ...eventPage.lines)
    if (eventPage.nextAfter !== undefined) {
      lines.push(`Continue frame events: ${this.pageRef(eventScope, eventPage.nextAfter)}`)
    }
    lines.push("", "## Direct children", ...childPage.lines)
    if (childPage.nextAfter !== undefined) {
      lines.push(`Continue children: ${this.pageRef(childScope, childPage.nextAfter)}`)
    }
    return boundedDocument(lines, `Frame · ${title}`)
  }

  private renderEvent(
    ref: string,
    descriptor: Record<string, unknown>,
    offset: number,
  ): HistoryDocument | undefined {
    const seq = numberField(descriptor, "seq")
    const agentId = stringField(descriptor, "agentId")
    const type = stringField(descriptor, "type")
    if (seq === undefined || agentId === undefined || type === undefined) return undefined

    const body = JSON.stringify(descriptor, null, 2)
    const end = Math.min(body.length, offset + EVENT_CHARS_PER_PAGE)
    const owner = stringField(descriptor, "frameId") ?? "root"
    const lines = [
      `# Event ${seq} · ${type}`,
      `Reference: ${ref}`,
      `Owner: ${agentId}/${owner}`,
      `Characters: ${offset}-${end} of ${body.length}`,
      "",
      body.slice(offset, end),
    ]
    if (end < body.length) {
      const nextRef = this.store.put({
        kind: "history.event-page",
        eventRef: ref,
        offset: end,
      })
      lines.push("", `Continue event: ${nextRef}`)
    }
    return boundedDocument(lines, `Event ${seq} · ${type}`)
  }

  private renderStoredEventPage(descriptor: Record<string, unknown>): HistoryDocument | undefined {
    const eventRef = stringField(descriptor, "eventRef")
    const offset = numberField(descriptor, "offset")
    if (eventRef === undefined || offset === undefined || offset < 0) return undefined
    let event: Record<string, unknown>
    try {
      event = this.store.get(eventRef)
    } catch {
      return undefined
    }
    if (stringField(event, "kind") !== "event") return undefined
    return this.renderEvent(eventRef, event, offset)
  }

  private renderPage(descriptor: Record<string, unknown>): HistoryDocument | undefined {
    const scope = decodeScope(descriptor)
    const after = numberField(descriptor, "after")
    if (!scope || after === undefined) return undefined
    const page = this.collectionPage(scope, after, EVENTS_PER_PAGE)
    const lines = [
      `# History page · ${oneLine(scopeLabel(scope), 300)}`,
      `Immutable sequence range: (${after}, ${scope.through}]`,
      "",
      ...page.lines,
    ]
    if (page.nextAfter !== undefined) {
      lines.push("", `Continue: ${this.pageRef(scope, page.nextAfter)}`)
    }
    return boundedDocument(lines, `History page · ${oneLine(scopeLabel(scope), 180)}`)
  }

  private renderStoredSearch(descriptor: Record<string, unknown>): HistoryDocument | undefined {
    const scope = decodeScope(descriptor)
    const query = stringField(descriptor, "query")
    const after = numberField(descriptor, "after")
    if (!scope || query === undefined || after === undefined) return undefined
    return this.renderSearch(scope, query, after)
  }

  private renderSearch(scope: Scope, query: string, after: number): HistoryDocument {
    const page = this.collectionPage(scope, after, SEARCH_RESULTS_PER_PAGE, query)
    const shownQuery = oneLine(JSON.stringify(query), 500)
    const lines = [
      `# History search · ${shownQuery}`,
      `Scope: ${oneLine(scopeLabel(scope), 300)}`,
      `Immutable sequence range: (${after}, ${scope.through}]`,
      "Literal substring search over archived event descriptors; no inferred terms.",
      "Linked text artifact bodies are not searched here; read/search their artifact refs explicitly.",
      "",
      ...page.lines,
    ]
    if (page.nextAfter !== undefined) {
      const nextRef = this.store.put({
        kind: "history.search",
        ...encodeScope(scope),
        query,
        after: page.nextAfter,
      })
      lines.push("", `Continue search: ${nextRef}`)
    }
    const document = boundedDocument(lines, `History search · ${oneLine(query, 180)}`)
    return { ...document, searched: true }
  }

  private scopeForDescriptor(ref: string, descriptor: Record<string, unknown>): Scope | undefined {
    const kind = stringField(descriptor, "kind")
    if (kind === "history.root") {
      const agentId = stringField(descriptor, "agentId")
      if (agentId === undefined) return undefined
      return { scope: "agent", agentId, lowerBound: 0, through: this.latestSequence({ agentId }) }
    }
    if (kind === "history.frame") {
      const agentId = stringField(descriptor, "agentId")
      const frameId = stringField(descriptor, "frameId")
      if (agentId === undefined || frameId === undefined) return undefined
      return {
        scope: "frame",
        agentId,
        frameId,
        lowerBound: 0,
        through: this.latestSequence({ agentId, frameId }),
      }
    }
    if (kind === "event") {
      const agentId = stringField(descriptor, "agentId")
      const frameId = stringField(descriptor, "frameId")
      const seq = numberField(descriptor, "seq")
      if (agentId === undefined || seq === undefined) return undefined
      return {
        scope: frameId === undefined ? "agent" : "frame",
        agentId,
        ...(frameId === undefined ? {} : { frameId }),
        lowerBound: Math.max(0, seq - 1),
        through: seq,
      }
    }
    if (kind === "history.event-page") {
      const eventRef = stringField(descriptor, "eventRef")
      if (eventRef === undefined) return undefined
      try {
        return this.scopeForDescriptor(eventRef, this.store.get(eventRef))
      } catch {
        return undefined
      }
    }
    if (kind === "history.page" || kind === "history.search") {
      const scope = decodeScope(descriptor)
      const after = numberField(descriptor, "after")
      if (!scope || after === undefined) return undefined
      return { ...scope, lowerBound: Math.max(scope.lowerBound, after) }
    }
    void ref
    return undefined
  }

  private collectionPage(
    scope: Scope,
    after: number,
    count: number,
    query?: string,
  ): { lines: string[]; nextAfter?: number } {
    if (after >= scope.through) return { lines: ["(no events)"] }

    const entries: StoredEvent[] = []
    let cursor = after
    let hasMore = false
    while (cursor < scope.through && entries.length <= count) {
      const filter: EventFilter = {
        agentId: scope.agentId,
        after: cursor,
        through: scope.through,
        order: "asc",
        limit: SCAN_BATCH,
      }
      if (scope.scope === "frame") filter.frameId = scope.frameId
      if (scope.scope === "children") {
        filter.type = "frame.open"
        filter.parentId = scope.parentId ?? null
      }
      if (query !== undefined) filter.query = query

      const batch = this.store.events(filter)
      if (batch.length === 0) break
      let advanced = false
      for (const entry of batch) {
        const seq = numberField(entry.value, "seq")
        if (seq === undefined || seq <= cursor) continue
        advanced = true
        cursor = seq
        if (seq > scope.through) break
        if (seq <= scope.lowerBound) continue
        if (scope.scope === "children" && openParentId(entry) !== scope.parentId) continue
        entries.push(entry)
        if (entries.length > count) {
          hasMore = true
          break
        }
      }
      if (entries.length > count || !advanced || batch.length < SCAN_BATCH || cursor >= scope.through) break
    }

    const visible = entries.slice(0, count)
    const lines = visible.map((entry) => eventSummary(entry))
    if (lines.length === 0) lines.push("(no events)")
    const lastVisibleSeq = visible.length > 0
      ? numberField(visible[visible.length - 1]!.value, "seq")
      : undefined

    // If filtering skipped a batch tail, probe for another matching event before
    // offering a continuation. The probe stays inside the captured upper bound.
    if (!hasMore && lastVisibleSeq !== undefined && lastVisibleSeq < scope.through) {
      hasMore = this.hasMatchingAfter(scope, lastVisibleSeq, query)
    }
    return hasMore && lastVisibleSeq !== undefined
      ? { lines, nextAfter: lastVisibleSeq }
      : { lines }
  }

  private hasMatchingAfter(scope: Scope, after: number, query?: string): boolean {
    let cursor = after
    while (cursor < scope.through) {
      const filter: EventFilter = {
        agentId: scope.agentId,
        after: cursor,
        through: scope.through,
        order: "asc",
        limit: SCAN_BATCH,
      }
      if (scope.scope === "frame") filter.frameId = scope.frameId
      if (scope.scope === "children") {
        filter.type = "frame.open"
        filter.parentId = scope.parentId ?? null
      }
      if (query !== undefined) filter.query = query
      const batch = this.store.events(filter)
      if (batch.length === 0) return false
      let advanced = false
      for (const entry of batch) {
        const seq = numberField(entry.value, "seq")
        if (seq === undefined || seq <= cursor) continue
        advanced = true
        cursor = seq
        if (seq > scope.through) return false
        if (seq <= scope.lowerBound) continue
        if (scope.scope !== "children" || openParentId(entry) === scope.parentId) return true
      }
      if (!advanced || batch.length < SCAN_BATCH) return false
    }
    return false
  }

  private pageRef(scope: Scope, after: number): string {
    return this.store.put({ kind: "history.page", ...encodeScope(scope), after })
  }

  private latestSequence(filter: EventFilter): number {
    const latest = this.latestEvent(filter)
    return latest ? numberField(latest.value, "seq") ?? 0 : 0
  }

  private latestEvent(filter: EventFilter): StoredEvent | undefined {
    return this.store.events({ ...filter, order: "desc", limit: 1 })[0]
  }

  private frameDetails(agentId: string, frameId: string): FrameDetails {
    const opened = this.latestEvent({ agentId, frameId, type: "frame.open" })
    const updated = this.latestEvent({ agentId, frameId, type: "frame.update" })
    const closed = this.latestEvent({ agentId, frameId, type: "frame.close" })
    const lifecycle = [opened, updated, closed]
      .filter((entry): entry is StoredEvent => entry !== undefined)
      .sort((left, right) => (numberField(right.value, "seq") ?? 0) - (numberField(left.value, "seq") ?? 0))
    const latest = lifecycle[0]
    const latestPayload = latest && recordField(latest.value, "payload")
    const storedFrame = latestPayload
      && (recordField(latestPayload, "frame") ?? recordField(recordField(latestPayload, "closed"), "intent"))
    const ownershipPayload = (opened && recordField(opened.value, "payload")) ?? latestPayload

    return {
      ...(storedFrame && isTaskFrame(storedFrame) ? { frame: storedFrame } : {}),
      ...(latestPayload && stringField(latestPayload, "frameRef")
        ? { frameRef: stringField(latestPayload, "frameRef") }
        : {}),
      ...(ownershipPayload && nullableStringField(ownershipPayload, "parentId")
        ? { parentId: nullableStringField(ownershipPayload, "parentId") }
        : {}),
      ...(ownershipPayload && stringField(ownershipPayload, "parentRef")
        ? { parentRef: stringField(ownershipPayload, "parentRef") }
        : {}),
      ...(opened ? { opened } : {}),
      ...(closed ? { closed } : {}),
    }
  }

  private findOwnership(agentId: string, frameId: string): { parentId?: string; parentRef?: string } | undefined {
    const opened = this.latestEvent({ agentId, frameId, type: "frame.open" })
    if (!opened) return undefined
    const payload = recordField(opened.value, "payload")
    return {
      parentId: nullableStringField(payload, "parentId"),
      parentRef: payload && stringField(payload, "parentRef"),
    }
  }

  private frameRefWithoutWriting(frameId: string, opened?: StoredEvent): string | undefined {
    const known = this.knownFrameRefs.get(frameId)
    if (known) return known
    const payload = opened && recordField(opened.value, "payload")
    return payload && stringField(payload, "frameRef")
  }

  private contextFrameLine(entry: StoredEvent, label: string, closed?: StoredEvent): string {
    const frameId = stringField(entry.value, "frameId") ?? "unknown"
    const payload = recordField(entry.value, "payload")
    const frame = payload
      && (recordField(payload, "frame") ?? recordField(recordField(payload, "closed"), "intent"))
    const title = frame && stringField(frame, "title") || frameId
    const frameRef = payload && stringField(payload, "frameRef") || "(missing ref)"
    const terminal = closed ?? (stringField(entry.value, "type") === "frame.close" ? entry : undefined)
    const outcome = terminal ? closeOutcome(terminal) ?? "closed" : "open"
    return `- ${label} ${oneLine(title, 100)} [${outcome}] — ${frameRef}`
  }
}

function encodeScope(scope: Scope): Record<string, unknown> {
  return {
    scope: scope.scope,
    agentId: scope.agentId,
    ...(scope.frameId === undefined ? {} : { frameId: scope.frameId }),
    ...(scope.parentId === undefined ? {} : { parentId: scope.parentId }),
    lowerBound: scope.lowerBound,
    through: scope.through,
  }
}

function decodeScope(value: Record<string, unknown>): Scope | undefined {
  const rawScope = stringField(value, "scope")
  const agentId = stringField(value, "agentId")
  const lowerBound = numberField(value, "lowerBound")
  const through = numberField(value, "through")
  if (
    (rawScope !== "agent" && rawScope !== "frame" && rawScope !== "children")
    || agentId === undefined
    || lowerBound === undefined
    || through === undefined
  ) return undefined
  const frameId = stringField(value, "frameId")
  const parentId = stringField(value, "parentId")
  if (rawScope === "frame" && frameId === undefined) return undefined
  return {
    scope: rawScope,
    agentId,
    ...(frameId === undefined ? {} : { frameId }),
    ...(parentId === undefined ? {} : { parentId }),
    lowerBound,
    through,
  }
}

function eventSummary(entry: StoredEvent): string {
  const seq = numberField(entry.value, "seq") ?? 0
  const type = stringField(entry.value, "type") ?? "event"
  const agentId = stringField(entry.value, "agentId") ?? "unknown-agent"
  const frameId = stringField(entry.value, "frameId")
  const payload = recordField(entry.value, "payload")
  let detail = ""
  if (type === "frame.open" || type === "frame.update") {
    const frame = payload && recordField(payload, "frame")
    const title = frame && stringField(frame, "title")
    if (title) detail = ` · ${title}`
  } else if (type === "frame.close") {
    const outcome = closeOutcome(entry)
    if (outcome) detail = ` · ${outcome}`
  } else {
    detail = ` · ${summarizePayload(payload ?? entry.value)}`
  }
  const summary = `#${seq} ${type} owner=${agentId}/${frameId ?? "root"}${detail}`
  return `- ${oneLine(summary, MAX_SUMMARY_CHARS)} — ${entry.ref}`
}

function summarizePayload(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function closeOutcome(entry: StoredEvent): string | undefined {
  const payload = recordField(entry.value, "payload")
  const closed = payload && recordField(payload, "closed")
  const disposition = closed && recordField(closed, "disposition")
  return disposition && stringField(disposition, "outcome")
}

function openParentId(entry: StoredEvent): string | undefined {
  const parentId = eventParentId(entry)
  return typeof parentId === "string" ? parentId : undefined
}

function eventParentId(entry: StoredEvent): string | null | undefined {
  const payload = recordField(entry.value, "payload")
  if (!payload || !("parentId" in payload)) return undefined
  const parentId = payload.parentId
  return typeof parentId === "string" || parentId === null ? parentId : undefined
}

function scopeLabel(scope: Scope): string {
  switch (scope.scope) {
    case "agent":
      return `agent ${scope.agentId}`
    case "frame":
      return `agent ${scope.agentId}, frame ${scope.frameId} only`
    case "children":
      return `agent ${scope.agentId}, direct children of ${scope.parentId ?? "root"}`
  }
}

function boundedDocument(lines: string[], title: string): HistoryDocument {
  const safeTitle = oneLine(title, 240)
  const text = lines.join("\n")
  if (text.length <= MAX_DOCUMENT_CHARS) return { text, title: safeTitle }

  // Keep generated recovery links even if a hostile/legacy descriptor makes a
  // header unexpectedly large. Query text is display-clipped by callers; the
  // full value remains in the immutable search descriptor.
  const continuations = lines
    .filter((line) => /^Continue(?: frame events| children| search| event)?: \S+$/.test(line))
    .slice(-4)
    .map((line) => oneLine(line, 500))
  const footer = continuations.length > 0 ? `\n${continuations.join("\n")}` : ""
  const marker = "\n… document clipped; read an exact event or continuation reference for more"
  const prefixLength = Math.max(0, MAX_DOCUMENT_CHARS - marker.length - footer.length)
  return {
    text: `${text.slice(0, prefixLength)}${marker}${footer}`,
    title: safeTitle,
  }
}

function isHistoryKind(kind: string | undefined): boolean {
  return kind === "history.root"
    || kind === "history.frame"
    || kind === "history.page"
    || kind === "history.search"
    || kind === "history.event-page"
    || kind === "event"
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "string" ? field : undefined
}

function nullableStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "string" ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "number" && Number.isSafeInteger(field) ? field : undefined
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTaskFrame(value: Record<string, unknown>): value is TaskFrame & Record<string, unknown> {
  return typeof value.id === "string" && typeof value.title === "string" && Array.isArray(value.todos)
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1))}…`
}

function snapshot<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value
  return structuredClone(value)
}
