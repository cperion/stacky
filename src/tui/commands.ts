import type { AgentRuntime } from "../agent/runtime.ts"
import { PROVIDERS } from "../llm/catalog.ts"
import { hasApiKey, type ProviderName } from "../llm/providers.ts"
import { listModels } from "../llm/models.ts"
import { clearAuth, loginWithBrowser } from "../llm/oauth.ts"
import type { SettingsController, UiMode } from "./settings.ts"

/** Everything a command needs, provided by whichever interface is running. */
export type CommandContext = {
  runtime: AgentRuntime
  settings: SettingsController
  /** Show a line/block of output to the user (chat note or scrollback block). */
  print: (text: string) => void
  switchUi: (mode: UiMode) => void
  quit: () => void
}

export type Command = {
  name: string
  aliases?: string[]
  usage: string
  description: string
  run: (argument: string, ctx: CommandContext) => void | Promise<void>
}

const COMMANDS: Command[] = [
  {
    name: "help",
    usage: "/help",
    description: "show this help",
    run: (_arg, ctx) => ctx.print(helpText()),
  },
  {
    name: "model",
    aliases: ["models"],
    usage: "/model [provider/id]",
    description: "show or choose a model",
    run: async (arg, ctx) => {
      if (!arg) {
        const lines = [`Current: ${ctx.runtime.llmLabel}`, ""]
        for (const provider of PROVIDERS) {
          const models = await listModels(provider)
          lines.push(`${provider}${hasApiKey(provider) ? "" : "  (no API key)"}:`)
          for (const model of models.slice(0, 40)) {
            const current = ctx.settings.config.provider === provider && ctx.settings.config.model === model
            lines.push(`  ${current ? "❯" : " "} ${model}`)
          }
          if (models.length > 40) lines.push(`    … ${models.length - 40} more`)
        }
        lines.push("", "Switch with /model <provider>/<model>")
        ctx.print(lines.join("\n"))
        return
      }
      const [providerPart, modelPart] = arg.includes("/") ? arg.split("/", 2) : [undefined, arg]
      const provider = (providerPart as ProviderName | undefined) ?? ctx.settings.config.provider
      if (!PROVIDERS.includes(provider) || !modelPart) {
        ctx.print('Usage: /model <provider>/<model>  e.g. deepseek/deepseek-flash')
        return
      }
      ctx.settings.config.provider = provider
      ctx.settings.config.model = modelPart
      ctx.settings.rebuildModel()
      ctx.settings.persist()
      ctx.print(`Model: ${provider}/${modelPart}`)
    },
  },
  {
    name: "thinking",
    aliases: ["think"],
    usage: "/thinking [on|off]",
    description: "toggle the model's reasoning mode",
    run: (arg, ctx) => {
      const value = arg ? arg === "on" : !ctx.settings.config.thinking
      ctx.settings.config.thinking = value
      ctx.settings.rebuildModel()
      ctx.settings.persist()
      ctx.print(`Thinking ${value ? "on" : "off"}.`)
    },
  },
  {
    name: "thinking-blocks",
    aliases: ["showthinking", "thinking-display"],
    usage: "/thinking-blocks [on|off]",
    description: "toggle the thinking display",
    run: (arg, ctx) => {
      const value = arg ? arg === "on" : !ctx.settings.config.showThinking
      ctx.settings.config.showThinking = value
      ctx.settings.persist()
      ctx.print(`Thinking display ${value ? "on" : "off"}.`)
    },
  },
  {
    name: "theme",
    usage: "/theme [auto|dark|light]",
    description: "colour scheme (restart to apply)",
    run: (arg, ctx) => {
      const valid = ["auto", "dark", "light"]
      if (!valid.includes(arg)) {
        ctx.print(`Theme is ${ctx.settings.config.theme}. Usage: /theme auto|dark|light`)
        return
      }
      ctx.settings.config.theme = arg as "auto" | "dark" | "light"
      ctx.settings.persist()
      ctx.print(`Theme set to ${arg}. Restart to apply.`)
    },
  },
  {
    name: "dashboard",
    aliases: ["dash"],
    usage: "/dashboard [on|off]",
    description: "toggle the task/files dashboard (REPL)",
    run: (arg, ctx) => {
      const value = arg ? arg === "on" : !ctx.settings.config.replDashboard
      ctx.settings.config.replDashboard = value
      ctx.settings.persist()
      ctx.print(`Dashboard ${value ? "on" : "off"}.`)
    },
  },
  {
    name: "status",
    usage: "/status",
    description: "runtime status",
    run: (_arg, ctx) => {
      const state = ctx.runtime.snapshot()
      const cfg = ctx.settings.config
      ctx.print(
        [
          "Status:",
          `  ui        ${cfg.ui}`,
          `  mode      ${state.mode}`,
          `  model     ${ctx.runtime.llmLabel}`,
          `  thinking  ${cfg.thinking ? "on" : "off"}`,
          `  theme     ${cfg.theme}`,
          `  depth     ${state.stack.length}`,
          `  files     ${state.files.length} / ${cfg.fileBudgetTokens} tokens`,
          `  llm       ${state.metrics.llmCalls} calls · ${state.metrics.toolCalls} tools`,
        ].join("\n"),
      )
    },
  },
  {
    name: "new",
    aliases: ["clear", "reset"],
    usage: "/new",
    description: "reset the session",
    run: (_arg, ctx) => {
      ctx.runtime.reset()
      ctx.print("Session reset.")
    },
  },
  {
    name: "ui",
    usage: "/ui panes|repl",
    description: "switch interface",
    run: (arg, ctx) => {
      if (arg === "panes" || arg === "pane" || arg === "tui") {
        ctx.switchUi("panes")
        return
      }
      if (arg === "repl") {
        ctx.switchUi("repl")
        return
      }
      ctx.print("Usage: /ui panes|repl")
    },
  },
  {
    name: "login",
    usage: "/login [chatgpt]",
    description: "sign in to a subscription provider (ChatGPT OAuth)",
    run: async (arg, ctx) => {
      const target = (arg.trim() || "chatgpt") as ProviderName
      if (target !== "chatgpt") {
        ctx.print('Only "chatgpt" uses login; other providers read API keys from the environment.')
        return
      }
      ctx.print("Opening your browser to sign in to ChatGPT…")
      try {
        const auth = await loginWithBrowser((url) => ctx.print(`If it doesn't open automatically: ${url}`))
        const account = auth.account_id ? ` (account ${auth.account_id.slice(0, 8)}…)` : ""
        ctx.print(`Signed in to ChatGPT${account}. Switch with /model chatgpt/gpt-5-codex`)
      } catch (error) {
        ctx.print(`Login failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  },
  {
    name: "logout",
    usage: "/logout [chatgpt]",
    description: "sign out of a subscription provider",
    run: (arg, ctx) => {
      if ((arg.trim() || "chatgpt") !== "chatgpt") {
        ctx.print("Nothing to sign out for that provider.")
        return
      }
      clearAuth()
      ctx.print("Signed out of ChatGPT.")
    },
  },
  {
    name: "quit",
    aliases: ["exit", "q"],
    usage: "/quit",
    description: "exit",
    run: (_arg, ctx) => ctx.quit(),
  },
]

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length))
  return ["Commands:", ...COMMANDS.map((command) => `  ${command.usage.padEnd(width)}  ${command.description}`)].join("\n")
}

export function findCommand(name: string): Command | undefined {
  const lower = name.toLowerCase()
  return COMMANDS.find((command) => command.name === lower || command.aliases?.includes(lower))
}

/**
 * Run a `/command ...` line. Returns true when the input was a command (handled
 * or unknown), false when it was ordinary text.
 */
export function runCommand(input: string, ctx: CommandContext): boolean {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return false
  const [name = "", ...rest] = trimmed.slice(1).split(/\s+/)
  const command = findCommand(name)
  if (!command) {
    ctx.print(`Unknown command /${name}. Try /help.`)
    return true
  }
  void command.run(rest.join(" ").trim(), ctx)
  return true
}

export const COMMAND_NAMES = COMMANDS.map((command) => command.name)
