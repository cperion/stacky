import { describe, expect, test } from "bun:test"
import { TaskStack } from "../src/stack/stack.ts"

const frame = (why: string) => ({
  why,
  scope: `scope: ${why}`,
  knownContext: "ctx",
  definitionOfDone: `done: ${why}`,
  todos: ["step one"],
})

describe("TaskStack", () => {
  test("push makes the new frame the top of stack", () => {
    const stack = new TaskStack()
    const a = stack.push(frame("A"))
    const b = stack.push(frame("B"))
    expect(stack.depth).toBe(2)
    expect(stack.top?.id).toBe(b.id)
    expect(stack.list()[0]?.id).toBe(a.id)
  })

  test("pop removes the top frame and records a disposition", () => {
    const stack = new TaskStack()
    const a = stack.push(frame("A"))
    stack.push(frame("B"))
    const closed = stack.pop({
      outcome: "disproven",
      whatWasDone: "checked",
      whyClosed: "hypothesis was wrong",
      evidence: "output",
      effectsOnParent: "try another direction",
    })
    expect(closed.intent.id).not.toBe(a.id)
    expect(closed.disposition.outcome).toBe("disproven")
    expect(stack.depth).toBe(1)
    expect(stack.top?.id).toBe(a.id)
  })

  test("pop on an empty stack throws", () => {
    const stack = new TaskStack()
    expect(() =>
      stack.pop({ outcome: "completed", whatWasDone: "x", whyClosed: "y", evidence: "", effectsOnParent: "" }),
    ).toThrow()
  })

  test("frames carry structured self-prompt fields", () => {
    const stack = new TaskStack()
    const f = stack.push({ why: "w", scope: "s", knownContext: "k", definitionOfDone: "d", todos: ["step one"] })
    expect(f).toMatchObject({ why: "w", scope: "s", knownContext: "k", definitionOfDone: "d", todos: [{ text: "step one", status: "pending" }] })
    expect(f.createdAt).toBeGreaterThan(0)
  })
})
