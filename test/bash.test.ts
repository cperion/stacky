import { expect, test } from "bun:test"
import { runBash } from "../src/tools/bash.ts"

test("bash retains stdout, labelled stderr, nonzero status and genuinely empty output", async () => {
  const result = await runBash("printf hello; printf warning >&2; exit 42", { cwd: process.cwd() })
  expect(result.ok).toBe(false)
  expect(result.value?.exitCode).toBe(42)
  expect(result.value?.output).toBe("hello\n[stderr]\nwarning")
  expect((await runBash("true", { cwd: process.cwd() })).value?.output).toBe("")
})

test("bash timeout kills a process group even when descendants ignore TERM and retain pipes", async () => {
  const at = performance.now()
  const result = await runBash("printf started; trap '' TERM; sleep 10 & wait", { cwd: process.cwd(), timeoutMs: 100 })
  expect(result.ok).toBe(false)
  expect(result.error).toContain("timed out")
  expect(result.value?.output).toContain("started")
  expect(performance.now() - at).toBeLessThan(3000)
})

test("a pre-aborted command is not spawned", async () => {
  const signal = AbortSignal.abort()
  const result = await runBash("sleep 10", { cwd: process.cwd(), signal })
  expect(result.error).toBe("Command interrupted before execution")
  expect(result.value).toBeUndefined()
})
