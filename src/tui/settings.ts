import type { StackyConfig } from "../config.ts"
import type { AgentRuntime } from "../agent/runtime.ts"
import { hasApiKey } from "../llm/providers.ts"

export type UiMode = "panes" | "repl"

/** How a UI session ended: quit entirely, or hand over to the other UI mode. */
export type UiResult = "quit" | "switch"

/** Shared mutable settings + the actions that apply/persist them. */
export type SettingsController = {
  config: StackyConfig
  configPath: string
  runtime: AgentRuntime
  isMock: boolean
  /** Rebuild the LLM client from `config` (provider/model/thinking). */
  rebuildModel(): void
  /** Persist `config` to disk. */
  persist(): void
}

/** A failed switch must not silently leave config and the active client disagreeing. */
export function changeModel(settings: SettingsController, patch: Partial<Pick<StackyConfig, "provider" | "model" | "thinking">>): void {
  if (settings.runtime.isRunning) throw new Error("Stop the current turn with Esc before switching models.")
  const previous = { provider: settings.config.provider, model: settings.config.model, thinking: settings.config.thinking }
  const next = { ...previous, ...patch }
  if (!settings.isMock && (patch.provider !== undefined || patch.model !== undefined) && !hasApiKey(next.provider)) {
    throw new Error(next.provider === "chatgpt" ? "Sign in first: /login chatgpt" : `Set ${next.provider.toUpperCase()}_API_KEY before selecting this provider.`)
  }
  Object.assign(settings.config, next)
  try {
    settings.rebuildModel()
    settings.persist()
  } catch (error) {
    Object.assign(settings.config, previous)
    settings.rebuildModel()
    throw error
  }
}
