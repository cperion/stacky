#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { AgentRuntime } from "./agent/runtime.ts"
import { attachSessionAutosave, loadSession } from "./agent/persistence.ts"
import { attachTraceLogger } from "./agent/logger.ts"
import { AiSdkClient } from "./llm/ai.ts"
import { DemoLLM } from "./llm/scripted.ts"
import { createModel, detectProvider, type ProviderName } from "./llm/providers.ts"
import { runApp } from "./tui/app.ts"
import type { LLMClient } from "./llm/client.ts"

const { values } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    provider: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string" },
    task: { type: "string" },
    "file-budget": { type: "string" },
    "conversation-budget": { type: "string" },
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
const fileBudgetTokens = numberOption(values["file-budget"], 24_000)
const conversationBudgetTokens = numberOption(values["conversation-budget"], 32_000)

const { llm, providerLabel } = createLLM()

const runtime = new AgentRuntime({
  cwd,
  llm,
  fileBudgetTokens,
  conversationBudgetTokens,
})

if (values.trace) {
  attachTraceLogger(runtime.bus, resolve(values.trace))
}

let resumeNote = ""
if (values.session) {
  const sessionPath = resolve(values.session)
  if (loadSession(runtime, sessionPath)) {
    const snapshot = runtime.snapshot()
    resumeNote = `resumed session: ${snapshot.stack.length} open frame(s), ${snapshot.closedFrames.length} closed`
  }
  attachSessionAutosave(runtime, sessionPath)
}

const positionalTask = process.argv.slice(2).find((arg) => !arg.startsWith("-"))
const initialTask = values.task ?? positionalTask

if (values.headless) {
  if (resumeNote) console.log(resumeNote)
  await runHeadless(runtime, initialTask)
} else {
  await runApp({
    runtime,
    fileBudgetTokens,
    providerLabel,
    ...(resumeNote ? { notice: resumeNote } : {}),
    ...(initialTask ? { initialTask } : {}),
  })
}

function createLLM(): { llm: LLMClient; providerLabel: string } {
  if (values.mock) {
    return { llm: new DemoLLM(), providerLabel: "mock/demo" }
  }
  const provider: ProviderName = (values.provider as ProviderName | undefined) ?? detectProvider()
  const created = createModel({
    provider,
    ...(values.model ? { model: values.model } : {}),
  })
  const hasKey = Boolean(process.env[`${provider.toUpperCase()}_API_KEY`])
  if (!hasKey) {
    console.error(
      `No API key found for provider "${provider}" (expected ${provider.toUpperCase()}_API_KEY).\n` +
        `Run with --mock for the offline demo, or set the key.`,
    )
    process.exit(1)
  }
  return {
    llm: new AiSdkClient(created.model, { temperature: 0 }),
    providerLabel: `${created.provider}/${created.modelId}`,
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
    // Print each observation exactly once.
    if (event.type === "state.changed") return
    const last = state.conversation[state.conversation.length - 1]
    if (last && last.role === "observation" && !seen.has(last.id)) {
      seen.add(last.id)
      console.log(indent(last.text))
    }
  })

  if (!task) {
    console.error("Headless mode requires a task: pass --task \"...\" or a positional task string.")
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
  --provider <name>        openai | anthropic | deepseek (default: auto-detect)
  --model <id>             Model id override
  --cwd <path>             Workspace root (default: current directory)
  --file-budget <tokens>   File working-set token budget (default: 24000)
  --conversation-budget <tokens>  Conversation token budget (default: 32000)
  --session <path>         Persist/restore task state (JSON). File contents are never stored.
  --trace <path>           Append a JSONL execution trace
  -h, --help               Show this help

Environment:
  OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY
  STACKY_PROVIDER, STACKY_MODEL

Keys (TUI):
  Enter       send message / choose highlighted option
  ↑ / ↓       move between choices when the agent asks a question
  h           toggle closed-frame history in the task pane
  Ctrl+C      quit
`)
}
