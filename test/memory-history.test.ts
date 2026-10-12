import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClosedFrame, TaskFrame } from "../src/agent/types.ts"
import { FrameHistory } from "../src/memory/history.ts"
import { MemoryStore } from "../src/memory/store.ts"

type Stored = { ref: string; value: Record<string, unknown> }

type Filters = {
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

class FakeMemoryStore {
  readonly directory = "/fake/archive"
  readonly filters: Filters[] = []
  putCalls = 0
  private sequence = 0
  private nextRef = 1
  private readonly byRef = new Map<string, Record<string, unknown>>()
  private readonly byValue = new Map<string, string>()
  private readonly eventRows: Stored[] = []
  private readonly texts = new Map<string, { text: string; title: string; [key: string]: unknown }>()

  put(value: Record<string, unknown>): string {
    this.putCalls += 1
    const key = canonical(value)
    const existing = this.byValue.get(key)
    if (existing) return existing
    const ref = `r${String(this.nextRef++).padStart(3, "0")}`
    this.byValue.set(key, ref)
    this.byRef.set(ref, structuredClone(value))
    return ref
  }

  get(ref: string): Record<string, unknown> {
    const value = this.byRef.get(ref)
    if (!value) throw new Error(`missing ${ref}`)
    return structuredClone(value)
  }

  text(text: string, meta: { title: string; [key: string]: unknown }): string {
    const ref = this.put({ kind: "text", text, meta })
    this.texts.set(ref, { text, ...structuredClone(meta) })
    return ref
  }

  loadText(ref: string): { text: string; title: string; [key: string]: unknown } {
    const value = this.texts.get(ref)
    if (!value) throw new Error(`missing text ${ref}`)
    return structuredClone(value)
  }

  record(event: Record<string, unknown>): string {
    const value = { kind: "event", seq: ++this.sequence, ...structuredClone(event) }
    const ref = this.put(value)
    this.eventRows.push({ ref, value: structuredClone(value) })
    return ref
  }

  events(filter: Filters = {}): Stored[] {
    this.filters.push(structuredClone(filter))
    const after = filter.after ?? 0
    const limit = filter.limit ?? 100
    const matching = this.eventRows
      .filter(({ value }) => typeof value.seq === "number" && value.seq > after)
      .filter(({ value }) => filter.before === undefined || (value.seq as number) < filter.before)
      .filter(({ value }) => filter.through === undefined || (value.seq as number) <= filter.through)
      .filter(({ value }) => filter.agentId === undefined || value.agentId === filter.agentId)
      .filter(({ value }) => filter.frameId === undefined || value.frameId === filter.frameId)
      .filter(({ value }) => filter.type === undefined || value.type === filter.type)
      .filter(({ value }) => {
        if (filter.parentId === undefined) return true
        const payload = value.payload as Record<string, unknown> | undefined
        return payload?.parentId === filter.parentId
      })
      .filter(({ value }) => filter.query === undefined || JSON.stringify(value).includes(filter.query))
    if (filter.order === "desc") matching.reverse()
    return matching.slice(0, limit).map((entry) => structuredClone(entry))
  }

  close(): void {}

  findRef(predicate: (value: Record<string, unknown>) => boolean): string | undefined {
    for (const [ref, value] of this.byRef) {
      if (predicate(value)) return ref
    }
    return undefined
  }

  all(predicate: (value: Record<string, unknown>) => boolean): Stored[] {
    return [...this.byRef].flatMap(([ref, value]) => predicate(value) ? [{ ref, value: structuredClone(value) }] : [])
  }
}

function frame(id: string, title = id): TaskFrame {
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    title,
    why: `why ${title}`,
    scope: `scope ${title}`,
    knownContext: `known ${title}`,
    definitionOfDone: `done ${title}`,
    todos: [{ id: `${id}-todo`, text: `todo ${title}`, status: "pending" }],
    createdAt: 100,
  }
}

function closed(intent: TaskFrame, outcome: ClosedFrame["disposition"]["outcome"] = "completed"): ClosedFrame {
  return {
    intent,
    disposition: {
      outcome,
      whatWasDone: `report for ${intent.id}`,
      whyClosed: `reason for ${intent.id}`,
      evidence: `evidence for ${intent.id}`,
      effectsOnParent: `effects for ${intent.id}`,
      closedAt: 200,
    },
  }
}

function payloadOf(value: Record<string, unknown>): Record<string, unknown> {
  return value.payload as Record<string, unknown>
}

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("FrameHistory durability", () => {
  test("records explicit ownership, immutable updates, and close artifact refs", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, "agent-a")
    const parent = frame("f1", "parent")
    const child = frame("f2", "child")

    const parentRef = history.open(parent)
    const childRef = history.open(child, parent.id, {
      spawnedFrom: "foreign-child-frame-ref",
      resume: "resume after delegated result",
    })
    expect(history.ref(child.id)).toBe(childRef)

    const open = store.events({ agentId: "agent-a", frameId: child.id, type: "frame.open" })[0]!
    const openPayload = payloadOf(open.value)
    expect(openPayload.parentId).toBe(parent.id)
    expect(open.value.parentId).toBe(parent.id)
    expect(openPayload.parentRef).toBe(parentRef)
    expect(openPayload.spawnedFrom).toBe("foreign-child-frame-ref")
    expect(openPayload.resume).toBe("resume after delegated result")

    history.update(child)
    child.todos[0]!.text = "mutated after archival"
    const update = store.events({ agentId: "agent-a", frameId: child.id, type: "frame.update" })[0]!
    const archivedFrame = payloadOf(update.value).frame as TaskFrame
    expect(archivedFrame.todos[0]!.text).toBe("todo child")

    const terminal = closed(child)
    const closeRef = history.close(terminal)
    const closeEvent = store.get(closeRef)
    const closePayload = payloadOf(closeEvent)
    expect(closePayload.parentRef).toBe(parentRef)
    expect(store.loadText(closePayload.reportRef as string).text).toBe("report for f2")
    expect(store.loadText(closePayload.evidenceRef as string).text).toBe("evidence for f2")
    expect(store.loadText(closePayload.parentEffectRef as string).text).toBe("effects for f2")
    expect((closePayload.closed as ClosedFrame).disposition.whyClosed).toBe("reason for f2")
  })

  test("keeps frame turns separate and freezes continuation sequence bounds", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, "agent-a")
    const one = frame("f1", "one")
    const two = frame("f2", "two")
    const oneRef = history.open(one)
    history.open(two, one.id)
    for (let index = 0; index < 22; index += 1) {
      history.event("tool.result", { marker: `one-${index}` }, one.id)
      if (index < 3) history.event("tool.result", { marker: `two-${index}` }, two.id)
    }

    const first = history.resolve(oneRef)!
    expect(first.text).toContain("frame only (descendants excluded)")
    expect(first.text).toContain("one-0")
    expect(first.text).not.toContain("two-0")

    const pageRef = store.findRef((value) => value.kind === "history.page" && value.scope === "frame" && value.frameId === one.id)
    expect(pageRef).toBeDefined()
    const pageDescriptor = store.get(pageRef!)
    const frozenThrough = pageDescriptor.through

    history.event("tool.result", { marker: "future-one" }, one.id)
    const continued = history.resolve(pageRef!)!
    expect(continued.text).not.toContain("future-one")
    expect(store.get(pageRef!).through).toBe(frozenThrough)
    expect(continued.text).toContain("one-15")
  })

  test("delegates literal searches to the event index with an exact immutable scope", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, "agent-a")
    const one = frame("f1", "one")
    const two = frame("f2", "two")
    const oneRef = history.open(one)
    history.open(two)
    history.event("message", { text: "literal [needle] in one" }, one.id)
    history.event("message", { text: "literal [needle] in two" }, two.id)

    const result = history.resolve(oneRef, "[needle]")!
    expect(result.searched).toBe(true)
    expect(result.text).toContain("literal [needle] in one")
    expect(result.text).not.toContain("literal [needle] in two")
    expect(result.text).toContain("Linked text artifact bodies are not searched here")
    expect(store.filters.some((filter) =>
      filter.agentId === "agent-a" && filter.frameId === one.id && filter.query === "[needle]"
    )).toBe(true)
  })

  test("freezes search continuations and keeps the full query only in its descriptor", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, "agent-a")
    const target = frame("f1", "search target")
    const targetRef = history.open(target)
    const longQuery = `needle-${"q".repeat(2_000)}`
    for (let index = 0; index < 24; index += 1) {
      history.event("message", { text: `${longQuery}-${index}` }, target.id)
    }

    const first = history.resolve(targetRef, longQuery)!
    expect(first.text.length).toBeLessThanOrEqual(14_000)
    const continuation = store.findRef((value) =>
      value.kind === "history.search" && value.frameId === target.id && value.query === longQuery
    )
    expect(continuation).toBeDefined()
    expect(first.text).toContain(`Continue search: ${continuation}`)
    expect(store.get(continuation!).query).toBe(longQuery)
    const frozenThrough = store.get(continuation!).through

    history.event("message", { text: `${longQuery}-future` }, target.id)
    const continued = history.resolve(continuation!)!
    expect(continued.text).not.toContain("future")
    expect(store.get(continuation!).through).toBe(frozenThrough)
  })

  test("resolves cross-agent frame links by descriptor ownership", () => {
    const store = new FakeMemoryStore()
    const parentHistory = new FrameHistory(store as never, "parent-agent")
    const childHistory = new FrameHistory(store as never, "child-agent")
    const child = frame("f9", "delegated investigation")
    const childRef = childHistory.open(child, undefined, { spawnedFrom: parentHistory.rootRef })
    childHistory.event("message", { text: "child-only observation" }, child.id)

    const fromParentResolver = parentHistory.resolve(childRef)!
    expect(fromParentResolver.title).toContain("delegated investigation")
    expect(fromParentResolver.text).toContain("Owner: child-agent")
    expect(fromParentResolver.text).toContain("child-only observation")
  })

  test("pages oversized event documents without losing their exact event reference", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, "agent-a")
    const longTail = `start-${"x".repeat(21_000)}-END-MARKER`
    const eventRef = history.event("tool.result", { output: longTail })

    const first = history.resolve(eventRef)!
    expect(first.text.length).toBeLessThan(14_000)
    expect(first.text).toContain(`Reference: ${eventRef}`)
    const continuation = store.findRef((value) => value.kind === "history.event-page" && value.eventRef === eventRef)
    expect(continuation).toBeDefined()
    const second = history.resolve(continuation!)!
    const finalContinuation = store.all((value) =>
      value.kind === "history.event-page"
      && value.eventRef === eventRef
      && typeof value.offset === "number"
      && value.offset > 10_000
    )[0]?.ref
    expect(finalContinuation).toBeDefined()
    const final = history.resolve(finalContinuation!)!
    expect(second.text).toContain("Characters: 10000-20000")
    expect(final.text).toContain("END-MARKER")
  })

  test("retains event continuation recovery when defensive clipping is required", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, `agent-${"a".repeat(15_000)}`)
    const eventRef = history.event("tool.result", { output: "x".repeat(15_000) })

    const document = history.resolve(eventRef)!
    const continuation = store.findRef((value) =>
      value.kind === "history.event-page" && value.eventRef === eventRef
    )
    expect(continuation).toBeDefined()
    expect(document.text.length).toBeLessThanOrEqual(14_000)
    expect(document.text).toContain("document clipped")
    expect(document.text).toContain(`Continue event: ${continuation}`)
  })

  test("renders a compact useful local map using only bounded indexed queries", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, "agent-a")
    const parent = frame("f1", "parent task")
    const current = frame("f2", "current task")
    const sibling = frame("f3", "finished sibling")
    const child = frame("f4", "recent child")
    history.open(parent)
    history.open(current, parent.id)
    history.open(sibling, parent.id)
    history.close(closed(sibling, "blocked"))
    history.open(child, current.id)
    history.close(closed(child, "completed"))
    history.event("message", { text: "RAW SECRET TURN MUST NOT LEAK" }, current.id)

    const writesBefore = store.putCalls
    store.filters.length = 0
    const context = history.context([parent, current])
    expect(store.putCalls).toBe(writesBefore)
    expect(context.length).toBeLessThanOrEqual(4_000)
    expect(context).toContain(history.rootRef)
    expect(context).toContain("current task")
    expect(context).toContain("recent child [completed]")
    expect(context).toContain("finished sibling [blocked]")
    expect(context).not.toContain("RAW SECRET TURN MUST NOT LEAK")
    expect(store.filters.every((filter) => filter.order === "desc" && (filter.limit ?? Infinity) <= 8)).toBe(true)
    expect(store.filters).toContainEqual(expect.objectContaining({
      type: "frame.open",
      parentId: current.id,
      order: "desc",
      limit: 3,
    }))
    expect(store.filters).toContainEqual(expect.objectContaining({
      type: "frame.close",
      parentId: parent.id,
      order: "desc",
      limit: 8,
    }))
  })

  test("uses descending limit-one lifecycle lookups instead of archive scans", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, "agent-a")
    const parent = frame("f1", "parent")
    const child = frame("f2", "child")
    history.open(parent)
    const childRef = history.open(child, parent.id)
    history.update(child)
    history.close(closed(child))
    for (let index = 0; index < 500; index += 1) history.event("noise", { index })

    store.filters.length = 0
    history.resolve(childRef)
    const lifecycle = store.filters.filter((filter) =>
      filter.frameId === child.id && filter.type?.startsWith("frame.")
    )
    expect(lifecycle.length).toBe(3)
    expect(lifecycle.every((filter) => filter.order === "desc" && filter.limit === 1)).toBe(true)
    expect(store.filters).toContainEqual(expect.objectContaining({
      agentId: "agent-a",
      frameId: child.id,
      order: "desc",
      limit: 1,
    }))
    expect(store.filters.some((filter) => filter.limit === 200 && filter.through === undefined)).toBe(false)
  })

  test("integrates with the durable store across restart and indexed parent navigation", () => {
    const directory = mkdtempSync(join(tmpdir(), "stacky-history-"))
    temporaryDirectories.push(directory)
    let store = new MemoryStore(directory)
    const history = new FrameHistory(store, "durable-agent")
    const parent = frame("f1", "durable parent")
    const child = frame("f2", "durable child")
    history.open(parent)
    const childRef = history.open(child, parent.id)
    history.event("message", { text: "durable observation" }, child.id)
    history.close(closed(child, "completed"))
    store.close()

    store = new MemoryStore(directory)
    const restored = new FrameHistory(store, "durable-agent")
    const document = restored.resolve(childRef)!
    expect(document.text).toContain("durable observation")
    expect(document.text).toContain("Outcome: completed")
    const context = restored.context([parent])
    expect(context).toContain("durable child [completed]")
    expect(store.events({
      agentId: "durable-agent",
      type: "frame.open",
      parentId: parent.id,
      order: "desc",
      limit: 1,
    })[0]?.value.frameId).toBe(child.id)
    store.close()
  })

  test("returns undefined for missing and non-history references", () => {
    const store = new FakeMemoryStore()
    const history = new FrameHistory(store as never, "agent-a")
    const artifactRef = store.put({ kind: "text", text: "not history" })
    expect(history.resolve(artifactRef)).toBeUndefined()
    expect(history.resolve("does-not-exist")).toBeUndefined()
  })
})

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}
