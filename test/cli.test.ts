import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const main = resolve(import.meta.dir, "../src/main.ts")
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

describe("CLI guidance", () => {
  test("help matches the linked executable and the shared keyboard controls", async () => {
    const result = await run(["--help"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("stacky [task]")
    expect(result.stdout).toContain("chatgpt")
    expect(result.stdout).toContain("Tab / Shift+Tab")
    expect(result.stdout).toContain("keep the draft")
  })

  test("invalid provider names fail before starting the agent", async () => {
    const result = await run(["--provider", "does-not-exist", "--mock", "--headless", "--task", "must not run"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Unknown provider "does-not-exist"')
    expect(result.stdout).toBe("")
  })
})
