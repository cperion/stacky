import type { StackyConfig } from "../config.ts"
import type { AgentRuntime } from "../agent/runtime.ts"

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
