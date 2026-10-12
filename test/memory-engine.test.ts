import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "../src/memory/store.ts"
import { WorkspaceMemory } from "../src/memory/views.ts"

const temporary: string[] = []

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), "stacky-memory-"))
  temporary.push(directory)
  return directory
}

function setup(budgetTokens = 500): { cwd: string; archive: string; store: MemoryStore; memory: WorkspaceMemory } {
  const root = temp()
  const cwd = join(root, "work")
  const archive = join(root, "archive")
  mkdirSync(cwd, { recursive: true })
  const store = new MemoryStore(archive)
  return { cwd, archive, store, memory: new WorkspaceMemory({ cwd, store, budgetTokens }) }
}

function canonicalHash(value: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
  return createHash("sha256").update(canonical).digest("hex")
}

function anchors(materialized: string): string[] {
  return [...materialized.matchAll(/^\[([0-9a-f]+)\|\d+\]/gm)].map((match) => match[1] as string)
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("MemoryStore", () => {
  test("uses canonical durable descriptors and collision-safe exact aliases", () => {
    const root = temp()
    const archive = join(root, "archive")
    const store = new MemoryStore(archive)

    const byPrefix = new Map<string, { value: Record<string, unknown>; hash: string }>()
    let pair: [{ value: Record<string, unknown>; hash: string }, { value: Record<string, unknown>; hash: string }] | undefined
    for (let n = 0; n < 20_000 && !pair; n++) {
      const value = { n }
      const hash = canonicalHash(value)
      const prior = byPrefix.get(hash.slice(0, 3))
      if (prior) pair = [prior, { value, hash }]
      else byPrefix.set(hash.slice(0, 3), { value, hash })
    }
    expect(pair).toBeDefined()
    const [first, second] = pair as NonNullable<typeof pair>
    const firstRef = store.put(first.value)
    const secondRef = store.put(second.value)
    expect(firstRef).toBe(first.hash.slice(0, 3))
    expect(secondRef.length).toBeGreaterThan(3)
    expect(store.put({ n: first.value.n })).toBe(firstRef)
    expect(store.get(firstRef)).toEqual(first.value)
    expect(() => store.get(firstRef.slice(0, 2))).toThrow("not found")
    store.close()

    const reopened = new MemoryStore(archive)
    expect(reopened.get(firstRef)).toEqual(first.value)
    expect(reopened.get(secondRef)).toEqual(second.value)
    expect(statSync(archive).mode & 0o777).toBe(0o700)
    expect(statSync(join(archive, "memory.sqlite")).mode & 0o777).toBe(0o600)
    reopened.close()
  })

  test("persists immutable text and ordered, literally searchable events", () => {
    const root = temp()
    const archive = join(root, "archive")
    let store = new MemoryStore(archive)
    const artifact = store.text("full output", { title: "command", tool: "bash" })
    const one = store.record({ type: "tool", agentId: "a", frameId: "f", payload: "100% literal" })
    const two = store.record({ type: "message", agentId: "a", frameId: "g", payload: "other" })
    expect(store.loadText(artifact)).toMatchObject({ text: "full output", title: "command", tool: "bash", omittedBytes: 0 })
    expect(store.events({ agentId: "a" }).map((event) => event.ref)).toEqual([one, two])
    expect(store.events({ query: "%" }).map((event) => event.ref)).toEqual([one])
    expect(store.events({ frameId: "f", type: "tool", after: 0 })[0]?.value).toMatchObject({ kind: "event", seq: 1 })
    const child = store.record({ type: "frame.open", agentId: "a", frameId: "child", parentId: "f" })
    expect(store.events({ parentId: "f", order: "desc", through: 3, before: 4 }).map((event) => event.ref)).toEqual([child])
    expect(store.events({ parentId: null }).map((event) => event.ref)).toEqual([one, two])
    expect(store.events({ order: "desc", limit: 2 }).map((event) => event.ref)).toEqual([child, two])
    store.close()

    store = new MemoryStore(archive)
    expect(store.loadText(artifact).text).toBe("full output")
    expect(store.events().length).toBe(3)
    store.close()
  })
})

describe("WorkspaceMemory", () => {
  test("renders bounded anchored views, pages coherently, and fragments oversized lines read-only", () => {
    const { cwd, store, memory } = setup(70)
    writeFileSync(join(cwd, "many.txt"), Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n"))
    expect(memory.read({ path: "many.txt" }).ok).toBe(true)
    const first = memory.materialize()
    expect(memory.totalTokens()).toBeLessThanOrEqual(70)
    expect(first).toContain("LIVE many.txt")
    const next = first.match(/Next: read\(ref="([0-9a-f]+)"\)/)?.[1]
    expect(next).toBeDefined()
    const lastShown = [...first.matchAll(/\|(\d+)\]/g)].at(-1)?.[1]

    memory.clear()
    expect(memory.read({ ref: next as string, budgetTokens: 70 }).ok).toBe(true)
    const second = memory.materialize()
    const firstShown = second.match(/\|(\d+)\]/)?.[1]
    expect(Number(firstShown)).toBeGreaterThan(Number(lastShown))

    writeFileSync(join(cwd, "huge.txt"), "x".repeat(5_000))
    memory.clear()
    memory.read({ path: "huge.txt", budgetTokens: 50 })
    const huge = memory.materialize()
    expect(memory.totalTokens()).toBeLessThanOrEqual(70)
    expect(huge).toContain("fragment line 1")
    expect(anchors(huge)).toHaveLength(0)
    store.close()
  })

  test("evicts at view granularity and excludes artifacts from compatibility file lists", () => {
    const { cwd, store, memory } = setup(70)
    writeFileSync(join(cwd, "a.txt"), "a\n".repeat(200))
    writeFileSync(join(cwd, "b.txt"), "b\n".repeat(200))
    memory.read({ path: "a.txt", budgetTokens: 65 })
    const second = memory.read({ path: "b.txt", budgetTokens: 65 })
    expect(second.evicted.some((item) => /^read\(\{ref:"[0-9a-f]+"\}\)$/.test(item))).toBe(true)
    expect(memory.list().map((entry) => entry.path)).toEqual(["b.txt"])
    memory.capture("artifact body", { title: "result" })
    expect(memory.list().every((entry) => entry.path !== "result")).toBe(true)
    expect(memory.totalTokens()).toBeLessThanOrEqual(70)
    store.close()
  })

  test("refreshes safely relocated live ranges without recency promotion and preserves historical anchors", () => {
    const { cwd, store, memory } = setup(300)
    const path = join(cwd, "fresh.txt")
    writeFileSync(path, "alpha\nbeta\ngamma\n")
    memory.read({ path: "fresh.txt" })
    const before = memory.materialize()
    const betaAnchor = before.match(/^\[([0-9a-f]+)\|2\] beta$/m)?.[1]
    const lastUsed = memory.list()[0]?.lastUsed
    expect(betaAnchor).toBeDefined()

    writeFileSync(path, "alpha\nBETA\ngamma\n")
    const refreshed = memory.materialize()
    expect(refreshed).toContain("BETA")
    expect(refreshed).not.toContain(`\n[${betaAnchor}|2] beta`)
    expect(memory.list()[0]?.lastUsed).toBe(lastUsed)

    memory.clear()
    expect(memory.read({ ref: betaAnchor as string }).ok).toBe(true)
    const historical = memory.materialize()
    expect(historical).toContain("READ-ONLY")
    expect(historical).toContain("beta")
    expect(readFileSync(path, "utf8")).toContain("BETA")
    store.close()
  })

  test("applies same-base anchor edits atomically and rejects stale or mixed-invalid edits", () => {
    const { cwd, store, memory } = setup(500)
    const path = join(cwd, "edit.txt")
    writeFileSync(path, "one\ntwo\nthree\n")
    memory.read({ path: "edit.txt" })
    const shown = memory.materialize()
    const refs = anchors(shown)
    expect(refs).toHaveLength(3)

    const result = memory.edit({ edits: [{ from: refs[1], through: refs[1], text: "TWO" }] })
    expect(result.ok).toBe(true)
    expect(readFileSync(path, "utf8")).toBe("one\nTWO\nthree\n")

    const current = memory.materialize()
    const currentRefs = anchors(current)
    const unchanged = readFileSync(path, "utf8")
    const refused = memory.edit({
      edits: [
        { before: currentRefs[0], text: "zero" },
        { from: "missing", through: "missing", text: "bad" },
      ],
    })
    expect(refused.ok).toBe(false)
    expect(readFileSync(path, "utf8")).toBe(unchanged)

    const stale = currentRefs[1] as string
    writeFileSync(path, "external\nchange\n")
    const staleResult = memory.edit({ edits: [{ from: stale, through: stale, text: "unsafe" }] })
    expect(staleResult.ok).toBe(false)
    expect(staleResult.message).toContain("Recovery")
    expect(readFileSync(path, "utf8")).toBe("external\nchange\n")
    store.close()
  })

  test("supports compatibility text edits only inside visible coverage and missing-file creation", () => {
    const { cwd, store, memory } = setup(65)
    const path = join(cwd, "legacy.txt")
    const content = `visible target\n${"padding\n".repeat(100)}hidden target\n`
    writeFileSync(path, content)
    memory.read({ path: "legacy.txt" })
    memory.materialize()

    expect(memory.edit({ path: "legacy.txt", edits: [{ oldText: "hidden target", newText: "nope" }] }).ok).toBe(false)
    expect(readFileSync(path, "utf8")).toBe(content)
    expect(memory.edit({ path: "legacy.txt", edits: [{ oldText: "visible target", newText: "VISIBLE" }] }).ok).toBe(true)
    expect(readFileSync(path, "utf8")).toContain("VISIBLE")

    const created = memory.edit({ path: "new/deep.txt", edits: [{ oldText: "", newText: "created" }] })
    expect(created.ok).toBe(true)
    expect(readFileSync(join(cwd, "new/deep.txt"), "utf8")).toBe("created")
    store.close()
  })

  test("find, immutable artifacts, and exported selections remain reference-addressed", () => {
    const { cwd, archive, store, memory } = setup(120)
    writeFileSync(join(cwd, "search.txt"), `${"early\n".repeat(50)}needle here\nlate\n`)
    expect(memory.read({ path: "search.txt", find: "needle here" }).ok).toBe(true)
    expect(memory.materialize()).toContain("needle here")

    memory.clear()
    const captured = memory.capture("secret artifact body", { title: "artifact" })
    expect(captured.ok).toBe(true)
    const exported = memory.exportViews()
    expect(JSON.stringify(exported)).not.toContain("secret artifact body")
    memory.clear()
    memory.restoreViews(exported)
    expect(memory.materialize()).toContain("secret artifact body")

    store.close()
    const reopened = new MemoryStore(archive)
    const restored = new WorkspaceMemory({ cwd, store: reopened, budgetTokens: 120 })
    expect(restored.read({ ref: captured.ref as string }).ok).toBe(true)
    expect(restored.materialize()).toContain("secret artifact body")
    reopened.close()
  })

  test("requires ordered, fully visible anchor ranges and never escalates edit coverage", () => {
    const { cwd, store, memory } = setup(500)
    const path = join(cwd, "coverage.txt")
    writeFileSync(path, Array.from({ length: 30 }, (_, index) => `row-${index}`).join("\n"))
    expect(memory.read({ path: "coverage.txt", budgetTokens: 55 }).ok).toBe(true)
    const first = memory.materialize().match(/^\[([0-9a-f]+)\|1\]/m)?.[1] as string
    expect(memory.read({ path: "coverage.txt", find: "row-20", budgetTokens: 200 }).ok).toBe(true)
    const hit = memory.materialize().match(/Line 21: read\(\{ref:"([0-9a-f]+)"\}\)/)?.[1] as string
    expect(hit).toBeDefined()
    expect(memory.read({ ref: hit, budgetTokens: 80 }).ok).toBe(true)
    const shown = memory.materialize()
    const distant = shown.match(/^\[([0-9a-f]+)\|21\]/m)?.[1] as string
    expect(first).toBeDefined()
    expect(distant).toBeDefined()
    expect(memory.edit({ edits: [{ from: first, through: distant, text: "unsafe" }] }).ok).toBe(false)

    memory.clear()
    memory.read({ path: "coverage.txt", budgetTokens: 200 })
    const refs = anchors(memory.materialize())
    expect(memory.edit({ edits: [{ from: refs[1], through: refs[0], text: "reversed" }] }).ok).toBe(false)

    writeFileSync(path, `inserted\n${readFileSync(path, "utf8")}`)
    expect(memory.edit({ path: "coverage.txt", edits: [{ oldText: "row-0", newText: "changed" }] }).ok).toBe(false)
    expect(readFileSync(path, "utf8")).toContain("row-0")
    store.close()
  })

  test("pages long Unicode lines without splitting surrogates or trimming authorized content", () => {
    const { cwd, store, memory } = setup(70)
    const content = `${"😀".repeat(300)}\ntail\n`
    writeFileSync(join(cwd, "unicode.txt"), content)
    const firstRead = memory.read({ path: "unicode.txt", budgetTokens: 50 })
    expect(firstRead.ok).toBe(true)
    let rendered = memory.materialize()
    expect(rendered).not.toContain("�")
    expect(memory.totalTokens()).toBeLessThanOrEqual(70)
    const firstNext = rendered.match(/Next: read\(ref="([0-9a-f]+)"\)/)?.[1] as string
    expect(firstNext).toBeDefined()
    const firstDescriptor = store.get(firstNext)
    expect(firstDescriptor.kind).toBe("file-page")
    expect(firstDescriptor.char).toBeGreaterThan(0)

    memory.clear()
    expect(memory.read({ ref: firstNext, budgetTokens: 50 }).ok).toBe(true)
    rendered = memory.materialize()
    expect(rendered).not.toContain("�")
    const secondNext = rendered.match(/Next: read\(ref="([0-9a-f]+)"\)/)?.[1] as string
    expect(secondNext).toBeDefined()
    expect(store.get(secondNext).char).toBeGreaterThan(firstDescriptor.char as number)

    const tiny = new WorkspaceMemory({ cwd, store, budgetTokens: 24 })
    expect(tiny.read({ path: "unicode.txt", budgetTokens: 24 }).ok).toBe(false)
    expect(tiny.materialize()).toBe("")
    store.close()
  })

  test("keeps unchanged file pages editable and changed pages historical with recovery", () => {
    const { cwd, store, memory } = setup(300)
    const path = join(cwd, "page.txt")
    writeFileSync(path, Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n"))
    memory.read({ path: "page.txt", budgetTokens: 60 })
    const page = memory.materialize().match(/Next: read\(ref="([0-9a-f]+)"\)/)?.[1] as string
    memory.clear()
    expect(memory.read({ ref: page, budgetTokens: 80 }).ok).toBe(true)
    let shown = memory.materialize()
    expect(shown).toContain("## LIVE page.txt")
    const pageAnchors = anchors(shown)
    expect(memory.edit({ edits: [{ from: pageAnchors[0], through: pageAnchors[0], text: "EDITED" }] }).ok).toBe(true)

    memory.clear()
    expect(memory.read({ ref: page, budgetTokens: 80 }).ok).toBe(true)
    shown = memory.materialize()
    expect(shown).toContain("READ-ONLY")
    expect(shown).toContain('current-file recovery: read(path="page.txt")')
    expect(memory.edit({ edits: [{ from: anchors(shown)[0], through: anchors(shown)[0], text: "NO" }] }).ok).toBe(false)
    store.close()
  })

  test("bounds default views, separates live and historical modes, and preserves leading edit context", () => {
    const { cwd, store, memory } = setup(10_000)
    const path = join(cwd, "bounded.txt")
    writeFileSync(path, "x".repeat(100_000))
    memory.read({ path: "bounded.txt" })
    expect(memory.totalTokens()).toBeLessThanOrEqual(4_096)

    memory.clear()
    writeFileSync(path, Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n"))
    memory.read({ path: "bounded.txt", budgetTokens: 300 })
    const live = memory.materialize()
    const oldAnchor = anchors(live)[0] as string
    expect(memory.read({ ref: oldAnchor, budgetTokens: 100 }).ok).toBe(true)
    const mixed = memory.materialize()
    expect(mixed).toContain("## LIVE")
    expect(mixed).toContain("## READ-ONLY")

    memory.clear()
    writeFileSync(path, "lead-0\nlead-1\ntarget\nafter\n")
    memory.read({ path: "bounded.txt", budgetTokens: 150 })
    expect(memory.edit({ path: "bounded.txt", edits: [{ oldText: "target", newText: "TARGET" }] }).ok).toBe(true)
    const edited = memory.materialize()
    expect(edited).toContain("lead-0")
    expect(edited).toContain("TARGET")
    expect(memory.totalTokens()).toBeLessThanOrEqual(10_000)
    store.close()
  })

  test("reports copyable eviction refs and never renders beyond a partial capture", () => {
    const { cwd, store, memory } = setup(80)
    writeFileSync(join(cwd, "one.txt"), "one\n".repeat(200))
    writeFileSync(join(cwd, "two.txt"), "two\n".repeat(200))
    memory.read({ path: "one.txt", budgetTokens: 70 })
    const evicted = memory.read({ path: "two.txt", budgetTokens: 70 }).evicted
    expect(evicted[0]).toMatch(/^read\(\{ref:"[0-9a-f]+"\}\)$/)

    memory.clear()
    const oversized = `${"a".repeat(8 * 1024 * 1024)}UNAVAILABLE_SUFFIX`
    const captured = memory.capture(oversized, { title: "oversized" })
    expect(captured.ref).toBeDefined()
    expect(store.loadText(captured.ref as string).text).not.toContain("UNAVAILABLE_SUFFIX")
    memory.setBudget(500)
    expect(memory.read({ ref: captured.ref as string, find: "UNAVAILABLE_SUFFIX" }).ok).toBe(true)
    expect(memory.materialize()).toContain("No literal matches")
    expect(memory.materialize()).toContain("omitted bytes are unavailable")
    store.close()
  })
})
