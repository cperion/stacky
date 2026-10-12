import type { AgentRuntime } from "../agent/runtime.ts"
import { PROVIDERS } from "../llm/catalog.ts"
import type { ProviderName } from "../llm/providers.ts"
import { cachedModels, clearModelCache, listModels } from "../llm/models.ts"
import { formatModelList } from "./model-list.ts"
import { clearAuth, loginWithBrowser } from "../llm/oauth.ts"
import { changeModel, type SettingsController, type UiMode } from "./settings.ts"

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
    usage: "/model [provider|provider/id|refresh [provider]]",
    description: "show or choose a model",
    run: async (arg, ctx) => {
      const trimmed = arg.trim()
      const refresh = /^refresh(?:\s+(\S+))?$/.exec(trimmed)
      const browse = PROVIDERS.find((provider) => provider === trimmed)
      if (!trimmed || refresh || browse) {
        const target = refresh?.[1] ?? browse
        if (target && !PROVIDERS.includes(target as ProviderName)) {
          ctx.print(`Unknown provider. Choose ${PROVIDERS.join(" | ")}.`)
          return
        }
        const providers = target ? [target as ProviderName] : PROVIDERS
        ctx.print(`Fetching model lists from ${providers.join(", ")}…`)
        // Opening the list is an explicit request for a fresh provider response.
        // Results arrive independently so one slow provider cannot hide the others.
        await Promise.all(providers.map(async (provider) => {
          const list = await listModels(provider, { force: true })
          ctx.print(formatModelList(provider, list, `${ctx.settings.config.provider}/${ctx.settings.config.model}`))
        }))
        ctx.print("Select: /model provider/id · filter with /model <name> then Tab · retry: /model refresh [provider]")
        return
      }
      const slash = trimmed.indexOf("/")
      const [providerPart, modelPart] = slash >= 0 ? [trimmed.slice(0, slash), trimmed.slice(slash + 1)] : [undefined, trimmed]
      const provider = (providerPart as ProviderName | undefined) ?? ctx.settings.config.provider
      if (!PROVIDERS.includes(provider) || !modelPart) {
        ctx.print('Usage: /model <provider>/<model>  e.g. deepseek/deepseek-flash')
        return
      }
      if (slash < 0 && !cachedModels(provider).includes(modelPart)) {
        ctx.print(`No exact model "${modelPart}" in the ${provider} list. Type /model ${modelPart} and press Tab to choose. For an unlisted id, use /model ${provider}/<exact-id>.`)
        return
      }
      changeModel(ctx.settings, { provider, model: modelPart })
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
      if (arg && !["on", "off"].includes(arg)) { ctx.print("Usage: /thinking on|off"); return }
      changeModel(ctx.settings, { thinking: value })
      ctx.print(`Thinking ${value ? "on" : "off"}.`)
    },
  },
  {
    name: "thinking-blocks",
    aliases: ["showthinking", "thinking-display"],
    usage: "/thinking-blocks [on|off]",
    description: "toggle the thinking display",
    run: (arg, ctx) => {
      if (arg && !["on", "off"].includes(arg)) { ctx.print("Usage: /thinking-blocks on|off"); return }
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
      if (arg && !["on", "off"].includes(arg)) { ctx.print("Usage: /dashboard on|off"); return }
      const value = arg ? arg === "on" : !ctx.settings.config.replDashboard
      ctx.settings.config.replDashboard = value
      ctx.settings.persist()
      ctx.print(`Dashboard ${value ? "on" : "off"}.`)
    },
  },
  {
    name: "task",
    usage: "/task",
    description: "show the full task stack and checklist",
    run: (_arg, ctx) => {
      const stack = ctx.runtime.snapshot().stack
      ctx.print(stack.length === 0 ? "No active task." : stack.map((frame, i) => [
        `${i + 1}. ${frame.title}`,
        `Why: ${frame.why}`,
        `Scope: ${frame.scope}`,
        `Known: ${frame.knownContext || "—"}`,
        `Done when: ${frame.definitionOfDone}`,
        ...frame.todos.map((todo) => `${todo.status === "done" ? "✓" : todo.status === "abandoned" ? "✗" : "·"} ${todo.text}${todo.note ? ` — ${todo.note}` : ""}`),
      ].join("\n")).join("\n\n"))
    },
  },
  {
    name: "files",
    usage: "/files",
    description: "show resident live file views (not archived files)",
    run: (_arg, ctx) => {
      const files = ctx.runtime.snapshot().files
      ctx.print(files.length ? files.map((file) => `${file.path}  ·  ${file.tokenCount} tokens`).join("\n") : "No files read yet.")
    },
  },
  {
    name: "context",
    usage: "/context",
    description: "show the agent's last working views and references",
    run: (_arg, ctx) => ctx.print(ctx.runtime.inspectContext()),
  },
  {
    name: "history",
    usage: "/history [ref]",
    description: "browse durable frame/event history; follow continuation refs",
    run: (arg, ctx) => ctx.print(ctx.runtime.inspectHistory(arg.trim() || undefined)),
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
          `  context   ${state.memory?.views ?? state.files.length} views · ~${state.memory?.usedTokens ?? 0} / ${cfg.fileBudgetTokens} tokens`,
          ...(state.memory ? [`  history   ${state.memory.historyRef} · ${state.memory.directory}`] : []),
          `  llm       ${state.metrics.llmCalls} calls · ${state.metrics.toolCalls} tools`,
        ].join("\n"),
      )
    },
  },
  {
    name: "new",
    aliases: ["clear", "reset"],
    usage: "/new",
    description: "clear active state (durable history is retained)",
    run: (_arg, ctx) => {
      ctx.runtime.reset()
      ctx.print("Active state cleared. Durable history remains available via /history.")
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
        clearModelCache("chatgpt")
        const account = auth.account_id ? ` (account ${auth.account_id.slice(0, 8)}…)` : ""
        ctx.print(`Signed in to ChatGPT${account}. Fetching your available models…`)
        ctx.print(formatModelList("chatgpt", await listModels("chatgpt", { force: true })))
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
      clearModelCache("chatgpt")
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
  return [
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.usage.padEnd(width)}  ${command.description}`),
    "",
    "Tab / Shift+Tab  choose completions · Enter accepts a selection, otherwise sends",
    "Shift+Enter / Alt+Enter  newline · Alt+Up/Down  history (keeps your draft)",
    "Esc  interrupt work or dismiss completion · Ctrl+C  quit",
    "Ctrl+P  commands (REPL) / settings (panes) · PageUp/Down  scroll chat (panes)",
  ].join("\n")
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
  try {
    Promise.resolve(command.run(rest.join(" ").trim(), ctx)).catch((error: unknown) => {
      ctx.print(`Could not /${command.name}: ${error instanceof Error ? error.message : String(error)}`)
    })
  } catch (error) {
    ctx.print(`Could not /${command.name}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return true
}

export const COMMAND_NAMES = COMMANDS.map((command) => command.name)
