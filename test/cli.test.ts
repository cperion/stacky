import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const main = resolve(import.meta.dir, "../src/main.ts")
async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, main, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
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

  test("--list-models reports missing credentials as JSON with no catalog substitution", async () => {
    const result = await run(["--list-models", "--provider", "openai"], { OPENAI_API_KEY: "" })
    expect(result.code).toBe(1)
    const lists = JSON.parse(result.stdout)
    expect(lists).toHaveLength(1)
    expect(lists[0].provider).toBe("openai")
    expect(lists[0].endpoint).toBe("https://api.openai.com/v1/models")
    expect(lists[0].ids).toEqual([])
    expect(lists[0].error).toContain("OPENAI_API_KEY")
    expect(result.stderr).toBe("")
  })

  test("invalid provider names fail before starting the agent", async () => {
    const result = await run(["--provider", "does-not-exist", "--mock", "--headless", "--task", "must not run"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Unknown provider "does-not-exist"')
    expect(result.stdout).toBe("")
  })
})
