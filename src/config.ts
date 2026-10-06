import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ProviderName } from "./llm/providers.ts"
import { defaultModelFor, providerForModel } from "./llm/catalog.ts"

export type StackyConfig = {
  provider: ProviderName
  model: string
  /** Keep the model's reasoning/thinking mode on. */
  thinking: boolean
  /** Render thinking blocks in the chat. */
  showThinking: boolean
  /** Which interface to launch. */
  ui: "panes" | "repl"
  /** Colour scheme: follow the terminal, or force one. */
  theme: "auto" | "dark" | "light"
  fileBudgetTokens: number
  conversationBudgetTokens: number
}

export function defaultConfig(): StackyConfig {
  return {
    provider: "deepseek",
    model: "deepseek-flash",
    thinking: false,
    showThinking: true,
    ui: "panes",
    theme: "auto",
    fileBudgetTokens: 24_000,
    conversationBudgetTokens: 32_000,
  }
}

export function configPath(): string {
  if (process.env.STACKY_CONFIG) return process.env.STACKY_CONFIG
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "stacky", "config.json")
}

export function loadConfig(path = configPath()): StackyConfig {
  const defaults = defaultConfig()
  if (!existsSync(path)) return defaults
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StackyConfig>
    const merged: StackyConfig = { ...defaults, ...parsed }
    // Keep provider/model consistent even if the file is hand-edited.
    const providerFromModel = providerForModel(merged.model)
    if (providerFromModel) merged.provider = providerFromModel
    if (!merged.model) merged.model = defaultModelFor(merged.provider)
    return merged
  } catch {
    return defaults
  }
}

export function saveConfig(config: StackyConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}
