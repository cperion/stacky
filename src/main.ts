#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { AgentRuntime } from "./agent/runtime.ts"
import { attachSessionAutosave, loadSession } from "./agent/persistence.ts"
import { attachTraceLogger } from "./agent/logger.ts"
import { buildLLM } from "./llm/factory.ts"
import { DemoLLM } from "./llm/scripted.ts"
import { configPath, loadConfig, saveConfig, type StackyConfig } from "./config.ts"
import type { ProviderName } from "./llm/providers.ts"
import { runApp } from "./tui/app.ts"
import { runRepl } from "./tui/repl.ts"
import type { SettingsController, UiResult } from "./tui/settings.ts"
import type { ModelInfo } from "./llm/factory.ts"

const { values, positionals } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    thinking: { type: "boolean" },
    provider: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string" },
    task: { type: "string" },
    "file-budget": { type: "string" },
    "conversation-budget": { type: "string" },
    config: { type: "string" },
    ui: { type: "string" },
    theme: { type: "string" },
    session: { type: "string" },
    trace: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
})

if (values.help) {
  printHelp()
  process.exit(0)
}

const cwd = resolve(values.cwd ?? process.cwd())

// Config file first, then CLI overrides.
const config: StackyConfig = loadConfig(values.config ? resolve(values.config) : configPath())
if (values.provider) config.provider = values.provider as ProviderName
if (values.model) config.model = values.model
if (values.thinking !== undefined) config.thinking = values.thinking
if (values.ui === "panes" || values.ui === "repl") config.ui = values.ui
if (values.theme === "auto" || values.theme === "dark" || values.theme === "light") config.theme = values.theme
if (values["file-budget"]) config.fileBudgetTokens = numberOption(values["file-budget"], config.fileBudgetTokens)
if (values["conversation-budget"])
  config.conversationBudgetTokens = numberOption(values["conversation-budget"], config.conversationBudgetTokens)

const usingMock = Boolean(values.mock)
let info: ModelInfo

const runtime = new AgentRuntime({
  cwd,
  llm: new DemoLLM(),
  fileBudgetTokens: config.fileBudgetTokens,
  conversationBudgetTokens: config.conversationBudgetTokens,
})

if (usingMock) {
  info = {
    provider: config.provider,
    modelId: config.model,
    thinking: config.thinking,
    hasApiKey: true,
    toolChoice: "auto",
    label: "mock/demo",
  }
} else {
  const built = buildLLM({ provider: config.provider, model: config.model, thinking: config.thinking })
  runtime.setLLM(built.llm)
  info = built.info
  if (!info.hasApiKey) {
    console.error(
      `No API key for "${config.provider}" (expected ${config.provider.toUpperCase()}_API_KEY).\n` +
        `Use --mock for the offline demo, or press Ctrl+P in the TUI to choose another model.`,
    )
  }
}

if (values.trace) attachTraceLogger(runtime.bus, resolve(values.trace))

let resumeNote = ""
if (values.session) {
  const sessionPath = resolve(values.session)
  if (loadSession(runtime, sessionPath)) {
    const snapshot = runtime.snapshot()
    resumeNote = `resumed session: ${snapshot.stack.length} open frame(s), ${snapshot.closedFrames.length} closed`
  }
  attachSessionAutosave(runtime, sessionPath)
}

const configFilePath = values.config ? resolve(values.config) : configPath()
const settings: SettingsController = {
  config,
  configPath: configFilePath,
  runtime,
  isMock: usingMock,
  rebuildModel() {
    if (usingMock) return
    runtime.setLLM(buildLLM({ provider: config.provider, model: config.model, thinking: config.thinking }).llm)
  },
  persist() {
    saveConfig(config, configFilePath)
  },
}

const positionalTask = positionals[0]
const initialTask = values.task ?? positionalTask

if (values.headless) {
  if (resumeNote) console.log(resumeNote)
  await runHeadless(runtime, initialTask)
} else {
  let firstRun = true
  let uiMode = config.ui
  for (;;) {
    const runOptions = {
      runtime,
      settings,
      ...(firstRun && initialTask ? { initialTask } : {}),
      ...(firstRun && resumeNote ? { notice: resumeNote } : {}),
    }
    let outcome: UiResult
    try {
      outcome = uiMode === "repl" ? await runRepl(runOptions) : await runApp(runOptions)
    } catch (error) {
      if (uiMode === "repl") {
        console.error(
          `Could not start the REPL interface (${error instanceof Error ? error.message : String(error)}).\n` +
            `Falling back to the panes interface.`,
        )
        config.ui = "panes"
        uiMode = "panes"
        continue
      }
      throw error
    }
    firstRun = false
    if (outcome === "switch") {
      uiMode = config.ui
      continue
    }
    break
  }
}

async function runHeadless(runtime: AgentRuntime, task: string | undefined): Promise<void> {
  const seen = new Set<string>()
  runtime.bus.on((event) => {
    const state = runtime.snapshot()
    switch (event.type) {
      case "frame.pushed":
        console.log(`\n▸ PUSH  [${state.stack.length}] ${event.frame.why.split("\n")[0]}`)
        break
      case "frame.popped":
        console.log(`\n✓ POP   ${event.frame.intent.why.split("\n")[0]}  → ${event.frame.disposition.outcome}`)
        break
      case "file.promoted":
        console.log(`  · file + ${event.path} (~${event.tokens} tokens)`)
        break
      case "file.evicted":
        console.log(`  · file - ${event.path} (evicted)`)
        break
      case "protocol.error":
        console.log(`  ! protocol error: ${event.message}`)
        break
      case "user.request":
        if (event.request.response === "none") {
          console.log(`\n──────────────\n${event.request.message}\n──────────────`)
        } else {
          console.log(`\n? ${event.request.message}`)
        }
        break
      case "fatal":
        console.error(`\nFATAL: ${event.message}`)
        break
    }
    if (event.type === "state.changed") return
    const last = state.conversation[state.conversation.length - 1]
    if (last && last.role === "observation" && !seen.has(last.id)) {
      seen.add(last.id)
      console.log(indent(last.text))
    }
  })

  if (!task) {
    console.error('Headless mode requires a task: pass --task "..." or a positional task string.')
    process.exit(1)
  }

  await runtime.request(task)
  if (runtime.isWaitingForUser) {
    console.log("\n(agent is waiting for user input; headless mode cannot reply)")
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

function numberOption(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function printHelp(): void {
  console.log(`stacky — a stack-driven LLM coding agent

Usage:
  bun run src/main.ts [task] [options]

Options:
  --task <text>            Initial task to give the agent
  --mock                   Use the offline demo model (no API key needed)
  --headless               Run without the TUI (streams events to stdout)
  --provider <name>        openai | anthropic | deepseek (default: deepseek)
  --model <id>             Model id override (default: deepseek-flash)
  --thinking               Keep the model's reasoning mode on (forces toolChoice auto)
  --cwd <path>             Workspace root (default: current directory)
  --file-budget <tokens>   File working-set token budget (default: 24000)
  --conversation-budget <tokens>  Conversation token budget (default: 32000)
  --config <path>          Config file (default: ${configPath()})
  --ui <mode>              panes | repl (default: from config, usually panes)
  --theme <mode>           auto | dark | light (light = black on white)
  --session <path>         Persist/restore task state (JSON). File contents are never stored.
  --trace <path>           Append a JSONL execution trace
  -h, --help               Show this help

Environment:
  DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY
  STACKY_PROVIDER, STACKY_MODEL, STACKY_CONFIG

Keys (TUI):
  Enter       send message / choose highlighted option / activate menu item
  ↑ / ↓       move through choices, menus and history
  Ctrl+P      model, thinking and settings menu
  Ctrl+T      toggle closed-frame history in the task pane
  Esc / ←     close or step back in a menu
  Ctrl+C      quit

REPL mode (--ui repl):
  Output flows into the terminal scrollback; the footer holds status + prompt.
  ↑ / ↓       recall previous inputs
  j / k / l   move/select the choice list when the agent asks (prompt empty)
  /help       list commands (/model, /thinking, /status, /new, /ui panes, /quit)

Defaults:
  provider    deepseek (falls back to whichever API key is set)
  model       deepseek-flash
`)
}
