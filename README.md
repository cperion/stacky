# stacky

A minimal **stack-driven LLM coding agent**. The design rationale lives in
[`idea.md`](./idea.md); the build plan lives in [`implementation.md`](./implementation.md).
This repository is the implementation.

## The idea in one paragraph

The model does not chat. Every turn it must call exactly one tool, and the runtime
decides what that tool *means*. Task state is an explicit **stack**. The files the model
sees are an explicit **token-bounded LRU** that is re-read from disk before every
inference, so context is never stale. The **only** way the agent produces user-visible
output is `user(...)`. Continuation is derived from tool semantics, never inferred from
prose.

```
ENVIRONMENT          bash(command) · read(path) · edit(path, edits)
EXECUTION CONTROL    push(taskFrame) · pop(disposition) · spawn(taskFrame)
HUMAN BOUNDARY       user(request)          <- the ONLY user-visible output
```

## Quick start

```bash
bun install

# Offline demo — no API key needed
bun run src/main.ts --mock --task "survey the repository"

# Real model (auto-detects provider from env)
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY / DEEPSEEK_API_KEY
bun run src/main.ts --task "fix the failing test in tests/auth.test.ts"

# Point at another workspace (deepseek is the default provider/model)
bun run src/main.ts --cwd /path/to/repo --provider deepseek --model deepseek-flash

# Headless (no TUI) — good for CI and scripts
bun run src/main.ts --headless --task "add a slugify() helper and test it"
```

### TUI

```
┌──────────────────┬────────────────────────────────┬──────────────────┐
│ TASK STACK       │ CHAT                           │ FILE WORKING SET │
│                  │                                │                  │
│ top frame:       │ user messages                  │ token pressure   │
│  Why/Scope/      │ user() reports & questions     │ active files     │
│  Known/Done      │ choices                        │ LRU order        │
│ parent frames    │ tool activity                  │ eviction         │
│                  │ > input                        │                  │
└──────────────────┴────────────────────────────────┴──────────────────┘
```

| Key | Action |
| --- | --- |
| `Enter` | send a message / activate the highlighted item / select a choice |
| `j` / `k` | move down / up through choices and menus |
| `h` / `l` | back / forward in menus; `l` selects a choice |
| `g` / `G` | jump to the top / bottom of a menu |
| `Esc` | close the menu, or clear a half-typed message |
| `Ctrl+P` | model, thinking and settings menu |
| `Ctrl+T` | toggle closed-frame history in the task pane |
| `Ctrl+C` | quit |

The TUI is vim-flavoured: `hjkl` drives every list and menu. While the chat
input has text, `j`/`k` are ordinary characters, so freeform replies still work;
the vim motions engage for the choice list only when the input is empty.

### Visual language

Contrast comes from **hierarchy**, not from hardcoded colours:

- Panes use dim (`ANSI 8`) borders and in-content headers with full-width rules;
  the chat border turns blue while working and yellow when it needs you.
- Roles are marked with a coloured left bar `▌` (green You, cyan Agent, magenta
  Thinking); tool calls and output are dimmed behind a `│` gutter, so the
  conversation stands out from the noise.
- Long text is hard-wrapped with the same indent on every line, so nothing turns
  ragged.
- The footer is a single line: a reverse-video mode chip, dim metadata, and a
  plain status hint — the only inverted element on screen.
- Semantic colours are ANSI palette indices (red/green/yellow/blue/magenta/cyan),
  so they follow the terminal's own theme.

## Interfaces

Two interfaces share the same runtime and can be switched at runtime:

- **REPL** (default) — output flows into the terminal's real scrollback, and a
  pinned footer shows the live status, the current task, the context files and the
  prompt, like a shell.
- **Panes** (`--ui panes`) — a fixed three-pane alternate-screen layout.

The REPL footer is the always-visible state surface:

```
stacky  ·  REPL mode. Type a task, or /help for commands.
▌ You
  fix the failing test
▌ Thinking
  │ The failure is in the token parser, so I should read it first.
  → read  src/token.ts
▌ token.ts · 84 lines · ~900 tokens · now in the working set
▌ Agent
  Fixed it. Tests pass.

 EXECUTE   deepseek/deepseek-flash · llm 6 · tools 5 · depth 1 · files 2   ctrl+c quit · Esc interrupts · /help
TASK   Fix the failing token test. The auth test fails only when refresh tokens are expired.
SCOPE  Inspect timestamp parsing and normalization only.
DONE   Determine whether parsing is responsible, with evidence for the parent frame.
────────────────────────────────────────────────────────────────────────────────────────
FILES  src/token.ts 1.2k   tests/token.test.ts 5.8k
❯ _
```

The dashboard is one unified panel: the top task frame (`TASK`/`SCOPE`/`DONE`, plus
`PARENT` when nested) with the file working set listed underneath. Values **wrap**
rather than being clipped, and the panel height grows with the content (collapse it
with `/dashboard off`). `--ui` can switch to the panes interface.

REPL keys: `↑`/`↓` recall previous inputs; `j`/`k`/`l` move and select the choice
list when the agent asks a question (while the prompt is empty); `Esc` interrupts the
in-flight model call (or clears a half-typed line); everything else is ordinary
typing. Slash commands replace the settings menu:

```
/help                 list commands
/model [provider/id]  show or choose a model
/thinking [on|off]    toggle the model's reasoning mode
/thinking-blocks      toggle thinking display
/status               runtime status
/new                  reset the session
/ui panes             switch to the panes interface
/quit                 exit
```

In the panes interface, `Ctrl+P` → **Interface** switches to the REPL; in the REPL,
`/ui panes` switches back. The selection is stored in the config file.

Switch with `--ui panes|repl` on the command line as well.

**Slash commands are identical in both interfaces** — type `/help`, `/model`,
`/status`, `/theme`, `/new`, `/ui` or `/quit` in either prompt. In the panes
interface the output appears in the chat; in the REPL it goes to the scrollback.

### Markdown & diffs

Agent and user messages render as markdown: headings, bullet/numbered lists, fenced
code blocks, blockquotes and rules, plus inline `code`, **bold**, *italic*,
~~strike~~ and [links](url). `edit()` tool calls render as a **diff** — removals in
red, additions in green:

```
  → edit  server.js
          - export const PORT = 3000
          + export const PORT = 8080
```

### Shading (user input + tool output only)

The interface itself stays **terminal-native** — panes, chat text, footer and input all
use the terminal's own default background. The tint is applied **only** to `▌ You`
messages and tool-output blocks.

That one tint is derived from your terminal's actual background (OSC 11) rather than
hardcoded: dark backgrounds get a slight lift, light backgrounds a slight drop — e.g.
`#1a1b26` → `#30313c`. Agent messages, thinking and all chrome keep the terminal's
background.

```
--theme auto | dark | light     (config key: theme)
```

`auto` follows the terminal's reported dark/light mode and derives the tint from its
background; `dark`/`light` force the direction. Change it with `--theme`,
`Ctrl+P` → **Theme** (panes) or `/theme` (REPL). Accents stay ANSI palette indices.

## Streaming & thinking


The model is called with `streamText`, so the UI updates as the model works:

- **Thinking** — reasoning deltas render live in a `✻ Thinking` block. When the turn
  finishes, the reasoning is kept as a `thinking` conversation entry and shown in the
  transcript. Thinking entries are **never** sent back to the model, so they cannot
  pollute the prompt.
- **Text** — any assistant text streams live, but is not persisted (the contract is
  tool-only output).
- **Tool calls** — `→ calling <tool>…` appears the moment the model starts emitting
  the call, before it is executed.
- A spinner and elapsed status appear in the footer while a turn is in flight;
  rendering is throttled so token streams stay smooth.

## Settings, models and config

Press `Ctrl+P` for the settings menu (vim keys: `j`/`k` move, `l`/Enter select,
`h` back, `g`/`G` jump, `Esc` close):

```
Settings
❯ Model              deepseek/deepseek-flash  ›
  Thinking           off
  Show thinking      on
  ── Context ──
  File budget        24000
  Conversation budget 32000
  ── Session ──
  Reset session
  Quit
```

The **Model** submenu lists every catalogued model across providers; selecting one
rebuilds the LLM client immediately. `Thinking` maps to the provider-agnostic
`reasoning` setting (`'none'` vs `'provider-default'`); DeepSeek V4 models think by
default, so it is disabled explicitly unless you turn it on.

Settings persist to `${XDG_CONFIG_HOME:-~/.config}/stacky/config.json` (override with
`STACKY_CONFIG` or `--config`). Only paths and preferences are stored — never file
contents.

## CLI

```
--task <text>              initial task
--mock                     offline demo model (no API key)
--headless                 stream events to stdout instead of the TUI
--provider <name>          openai | anthropic | deepseek (default: deepseek)
--model <id>               model id override (default: deepseek-flash)
--thinking                 keep the model's reasoning mode on (forces toolChoice auto)
--cwd <path>               workspace root (default: cwd)
--file-budget <tokens>     file working-set budget (default 24000)
--conversation-budget <t>  conversation budget (default 32000)
--session <path>           persist/restore task state as JSON
--trace <path>             append a JSONL execution trace
--config <path>            settings file (default: ~/.config/stacky/config.json)
-h, --help                 help
```

Environment: `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`STACKY_PROVIDER`, `STACKY_MODEL`. Defaults to DeepSeek `deepseek-flash` when no key
is found for another provider.

The TUI is terminal-native: it paints no background, uses the terminal's default
foreground for text and borders, and ANSI palette indices (SGR `38;5;N`) for semantic
accents — so it inherits whatever colour scheme the terminal is configured with, on
both light and dark backgrounds. It never hardcodes RGB colours.

## Architecture

```
src/
├── main.ts                 CLI + provider wiring
├── config.ts               settings persistence (~/.config/stacky/config.json)
├── agent/
│   ├── types.ts            TaskFrame, ClosedFrame, UserRequest, AgentState, StreamingState
│   ├── runtime.ts          the state machine: loop, dispatch, mode rules, streaming, metrics
│   ├── prompt.ts           system rules + prompt assembly (conversation/stack/files/event)
│   ├── conversation.ts     bounded raw history (no summaries)
│   ├── events.ts           event bus between runtime and UI
│   ├── persistence.ts      session save/load (paths only, never contents)
│   ├── logger.ts           JSONL trace
│   └── metrics.ts          counters
├── stack/
│   ├── schemas.ts          Zod schemas for all six actions (the tool contract)
│   └── stack.ts            TaskStack
├── files/
│   └── lru.ts              token-bounded FileWorkingSet (paths only)
├── tools/
│   ├── bash.ts  read.ts  edit.ts
├── llm/
│   ├── client.ts           narrow LLMClient interface + stream handlers
│   ├── ai.ts               Vercel AI SDK adapter (streamText, toolChoice, reasoning)
│   ├── tools.ts            AI SDK tool defs (no execute — the runtime executes)
│   ├── providers.ts        openai/anthropic/deepseek model creation
│   ├── catalog.ts          selectable model ids per provider
│   ├── factory.ts          config -> LLM client + model info
│   └── scripted.ts         ScriptedLLM (tests) + DemoLLM (--mock)
└── tui/
    ├── app.ts  task-pane.ts  chat-pane.ts  file-pane.ts  theme.ts  render.ts
    ├── menu.ts             modal menu overlay (vim keys)
    ├── menus.ts            settings / model / thinking / config menus
    └── settings.ts         shared SettingsController type
```

Note: the loop is implemented inside `runtime.ts` rather than a separate `loop.ts`.

### Subagents

A task frame is the natural delegation boundary. `spawn({why, scope, knownContext,
definitionOfDone})` runs that frame in a **fresh subagent** with its own task stack,
file working set and conversation. The parent blocks on the spawn, then receives the
subagent's report as an observation:

```
  → spawn  Count the .js files under src/ and report the count
▌ │ ⤷ → bash  find src -name '*.js' | sort
▌ │ ⤷ src/a.js
▌ │ ⤷ src/b.js
▌ │ ⤷ → agent
▌ subagent report: 3 .js files: src/a.js, src/b.js, src/c.js
```

- Each subagent keeps its **own stack and its own file LRU** — it does not inherit
  the parent's context, and its transcript is forwarded to the parent as
  `subagent` entries that are shown indented (`⤷`) but **excluded from the parent's
  prompt** (and capped, so a chatty subagent cannot flood the parent).
- Subagents share the working directory, so edits land on disk; the parent
  re-reads files it cares about.
- Subagents cannot ask the human ("A subagent cannot ask the user. Report with
  `user(response:none)` instead.") and must finish with a `user(response:none)`
  report. Nesting is bounded (`maxDepth`, default 2).

## Runtime invariants

- **Tool-only output.** Every model turn must validate against exactly one Zod schema.
  Invalid output is rejected and reported back as a protocol error; it is never
  silently reinterpreted.
- **No raw assistant text.** The only user-visible channel is `user(...)`.
- **File freshness.** Active files are re-read from disk before every inference. If
  conversation history conflicts with the current file context, the file context wins.
- **Single active task.** Only the top frame is executable. `bash`/`read`/`edit`/`pop`
  require a frame; in push mode only `push`/`user` are available.
- **Bounded delegation.** `spawn` gives a frame to an isolated subagent (own stack,
  own file LRU, own history). Depth is capped, subagents cannot ask the human, and
  their transcript is excluded from the parent's prompt.
- **Pop ≠ success.** `pop` records a disposition: `completed`, `disproven`,
  `unnecessary`, `abandoned`, `superseded`, `blocked`, `failed`, `partial`.
- **User does not change the stack.** `user(response:"required")` suspends and resumes
  the *same* frame; `user(response:"none")` reports and yields.
- **Persistence never stores file contents**, only paths; on restart everything is
  re-materialized from disk.

## Development

```bash
bun test          # 29 tests: stack, file LRU, runtime, persistence, streaming, config, metrics
bunx tsc --noEmit # strict typecheck
```

## Not built (on purpose)

Embeddings, vector search, subagents, parallel tasks, task DAGs, summarization,
plugins, background jobs. The value is in the small instruction set; test that first.
