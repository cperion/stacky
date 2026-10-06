import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileWorkingSet } from "../src/files/lru.ts"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stacky-files-"))
  writeFileSync(join(dir, "a.ts"), "a".repeat(400))
  writeFileSync(join(dir, "b.ts"), "b".repeat(400))
  writeFileSync(join(dir, "c.ts"), "c".repeat(400))
  writeFileSync(join(dir, "d.ts"), "d".repeat(400))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("FileWorkingSet", () => {
  test("promotes files and evicts the least recently used", () => {
    // ~100 tokens per file, budget for 3 files.
    const lru = new FileWorkingSet({ cwd: dir, budgetTokens: 320 })
    lru.promote("a.ts")
    lru.promote("b.ts")
    lru.promote("c.ts")
    lru.promote("a.ts") // touch a -> b should be coldest
    const { evicted } = lru.promote("d.ts")
    expect(evicted).toContain("b.ts")
    expect(lru.has("a.ts")).toBe(true)
    expect(lru.has("b.ts")).toBe(false)
  })

  test("moves a re-read file to the hot end", () => {
    const lru = new FileWorkingSet({ cwd: dir, budgetTokens: 1000 })
    lru.promote("a.ts")
    lru.promote("b.ts")
    lru.promote("a.ts")
    expect(lru.list()[0]?.path).toBe("a.ts")
  })

  test("stable order is first-seen order, independent of recency", () => {
    const lru = new FileWorkingSet({ cwd: dir, budgetTokens: 1000 })
    lru.promote("c.ts")
    lru.promote("a.ts")
    lru.promote("b.ts")
    lru.promote("a.ts")
    expect(lru.stableOrder().map((e) => e.path)).toEqual(["c.ts", "a.ts", "b.ts"])
  })

  test("materialize re-reads from disk so contents are never stale", () => {
    const lru = new FileWorkingSet({ cwd: dir, budgetTokens: 1000 })
    lru.promote("a.ts")
    writeFileSync(join(dir, "a.ts"), "fresh content")
    const [file] = lru.materialize()
    expect(file?.content).toBe("fresh content")
    expect(file?.missing).toBe(false)
  })

  test("missing files are reported, not silently dropped", () => {
    const lru = new FileWorkingSet({ cwd: dir, budgetTokens: 1000 })
    lru.promote("does-not-exist.ts")
    const [file] = lru.materialize()
    expect(file?.missing).toBe(true)
  })
})
