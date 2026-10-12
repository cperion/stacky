import type { MenuItem } from "./menu.ts"
import { changeModel, type SettingsController, type UiMode } from "./settings.ts"
import type { StackyConfig } from "../config.ts"
import { PROVIDERS } from "../llm/catalog.ts"
import { listModels } from "../llm/models.ts"
import { modelListSummary } from "./model-list.ts"
import { hasApiKey } from "../llm/providers.ts"

export type MenuContext = SettingsController & {
  close: () => void
  resetSession: () => void
  switchUi: (mode: UiMode) => void
  quit: () => void
}

const FILE_BUDGETS = ["8000", "16000", "24000", "48000", "96000"]
const CONVERSATION_BUDGETS = ["16000", "32000", "64000", "128000"]

/** The settings menu, opened with Ctrl+P. */
export function buildSettingsMenu(ctx: MenuContext): MenuItem[] {
  const cfg = ctx.config

  const commitContext = () => {
    ctx.persist()
    ctx.runtime.setBudgets({
      fileBudgetTokens: cfg.fileBudgetTokens,
      conversationBudgetTokens: cfg.conversationBudgetTokens,
    })
  }

  return [
    {
      kind: "submenu",
      label: "Model",
      hint: `${cfg.provider}/${cfg.model}${ctx.isMock ? " (mock)" : ""}`,
      items: () => modelItems(ctx),
    },
    {
      kind: "toggle",
      label: "Thinking",
      hint: "model reasoning",
      value: () => cfg.thinking,
      set: (v) => {
        changeModel(ctx, { thinking: v })
      },
    },
    {
      kind: "toggle",
      label: "Show thinking",
      hint: "render in chat",
      value: () => cfg.showThinking,
      set: (v) => {
        cfg.showThinking = v
        ctx.persist()
      },
    },
    {
      kind: "choice",
      label: "Interface",
      hint: "panes / repl",
      value: () => cfg.ui,
      options: () => ["panes", "repl"],
      set: (v) => ctx.switchUi(v as UiMode),
    },
    {
      kind: "choice",
      label: "Theme",
      hint: "restart to apply",
      value: () => cfg.theme,
      options: () => ["auto", "dark", "light"],
      set: (v) => {
        cfg.theme = v as StackyConfig["theme"]
        ctx.persist()
      },
    },
    { kind: "separator", label: "Context" },
    {
      kind: "choice",
      label: "Working-view budget",
      value: () => String(cfg.fileBudgetTokens),
      options: () => FILE_BUDGETS,
      set: (v) => {
        cfg.fileBudgetTokens = Number(v)
        commitContext()
      },
    },
    {
      kind: "choice",
      label: "Conversation budget",
      value: () => String(cfg.conversationBudgetTokens),
      options: () => CONVERSATION_BUDGETS,
      set: (v) => {
        cfg.conversationBudgetTokens = Number(v)
        commitContext()
      },
    },
    { kind: "separator", label: "Session" },
    {
      kind: "action",
      label: "Reset session",
      hint: "clear active state; retain archive",
      run: () => ctx.resetSession(),
    },
    { kind: "action", label: "Quit", run: () => ctx.quit() },
    { kind: "separator", label: "Config file" },
    { kind: "action", label: ctx.configPath, hint: "saved automatically", keepOpen: true, run: () => {} },
  ]
}

function modelItems(ctx: MenuContext): MenuItem[] {
  return PROVIDERS.map((provider) => ({
    kind: "submenu",
    label: provider,
    hint: hasApiKey(provider)
      ? (ctx.config.provider === provider ? ctx.config.model : "browse models")
      : provider === "chatgpt" ? "/login chatgpt first" : "API key required",
    items: async () => {
      // Opening a provider is an explicit request for its current list, not a stale catalog view.
      const list = await listModels(provider, { force: true })
      if (list.source === "unavailable") throw new Error(`${provider}: ${list.error ?? "No provider response."}`)
      return [
        { kind: "separator", label: modelListSummary(list) },
        ...(list.error ? [{ kind: "action" as const, label: "Why refresh failed", keepOpen: true, run: () => { throw new Error(list.error) } }] : []),
        ...list.ids.map((model): MenuItem => ({
          kind: "action",
          label: model,
          checked: ctx.config.provider === provider && ctx.config.model === model,
          run: () => changeModel(ctx, { provider, model }),
        })),
      ]
    },
  }))
}
