import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, loadConfig, saveConfig } from "../src/config.ts"

const dirs: string[] = []

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "stacky-config-"))
  dirs.push(dir)
  return join(dir, "config.json")
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("config store", () => {
  test("returns defaults when the file is missing", () => {
    const config = loadConfig(tempPath())
    expect(config).toEqual(defaultConfig())
    expect(config.provider).toBe("deepseek")
    expect(config.model).toBe("deepseek-flash")
    expect(config.thinking).toBe(false)
  })

  test("round-trips through disk", () => {
    const path = tempPath()
    const config = defaultConfig()
    config.provider = "anthropic"
    config.model = "claude-sonnet-4-5"
    config.thinking = true
    config.showThinking = false
    config.fileBudgetTokens = 48_000
    saveConfig(config, path)
    expect(loadConfig(path)).toEqual(config)
  })

  test("keeps provider consistent with a hand-edited model", () => {
    const path = tempPath()
    saveConfig({ ...defaultConfig(), provider: "deepseek", model: "gpt-4o-mini" }, path)
    expect(loadConfig(path).provider).toBe("openai")
  })

  test("falls back to defaults on malformed JSON", () => {
    const path = tempPath()
    saveConfig(defaultConfig(), path)
    require("node:fs").writeFileSync(path, "{ not json")
    expect(loadConfig(path)).toEqual(defaultConfig())
  })
})
