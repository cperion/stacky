import type { MenuItem } from "./menu.ts"
import type { SettingsController, UiMode } from "./settings.ts"
import type { StackyConfig } from "../config.ts"
import { PROVIDERS } from "../llm/catalog.ts"
import { cachedModels } from "../llm/models.ts"
import { hasApiKey, type ProviderName } from "../llm/providers.ts"

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

  const commitModel = () => {
    ctx.persist()
    ctx.rebuildModel()
  }
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
      items: () => modelItems(ctx, commitModel),
    },
    {
      kind: "toggle",
      label: "Thinking",
      hint: "model reasoning",
      value: () => cfg.thinking,
      set: (v) => {
        cfg.thinking = v
        commitModel()
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
      label: "File budget",
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
      hint: "clear stack, chat, files",
      run: () => ctx.resetSession(),
    },
    { kind: "action", label: "Quit", run: () => ctx.quit() },
    { kind: "separator", label: "Config file" },
    { kind: "action", label: ctx.configPath, hint: "saved automatically", keepOpen: true, run: () => {} },
  ]
}

function modelItems(ctx: MenuContext, commitModel: () => void): MenuItem[] {
  const items: MenuItem[] = []
  for (const provider of PROVIDERS) {
    const available = hasApiKey(provider)
    items.push({
      kind: "separator",
      label: `${provider}${available ? "" : " — no API key"}`,
    })
    for (const model of cachedModels(provider)) {
      items.push({
        kind: "action",
        label: model,
        checked: ctx.config.provider === provider && ctx.config.model === model,
        run: () => {
          ctx.config.provider = provider as ProviderName
          ctx.config.model = model
          commitModel()
        },
      })
    }
  }
  return items
}
