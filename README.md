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
EXECUTION CONTROL    push(taskFrame) · pop(disposition)
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

- **Panes** (default) — a fixed three-pane alternate-screen layout.
- **REPL** (`--ui repl`) — output flows into the terminal's real scrollback and only
a compact status + prompt footer stays pinned at the bottom, like a shell.

```
stacky  ·  REPL mode. Type a task, or /help for commands.
▌ You
  fix the failing test
▌ Thinking
  │ The failure is in the token parser, so I should read it first.
  → read  ({"path":"src/token.ts"})
  │ read src/token.ts: 84 lines, ~900 tokens.
▌ Agent
  Fixed it. Tests pass.

 EXECUTE   deepseek/deepseek-flash · llm 6 · depth 1 · files 3   ctrl+c quit · /help
❯ _
```

REPL keys: `↑`/`↓` recall previous inputs; `j`/`k`/`l` move and select the choice
list when the agent asks a question (while the prompt is empty); everything else is
ordinary typing. Slash commands replace the settings menu:

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

### Shading and theme modes

One tint is shared by **user input** and **tool output**, and it is **derived from
your terminal's own background** rather than hardcoded. In `auto` mode the renderer
asks the terminal for its default background (OSC 11) and lifts it slightly — e.g.
`#1a1b26` → `#30313c` — so the band is subtle and matches your colour scheme.
Agent messages and thinking keep the default background.

```
--theme auto | dark | light     (config key: theme)
```

- `auto` — follow the terminal's reported dark/light mode, and derive the tint
  from its background.
- `dark` — force the dark palette (terminal background + default foreground).
- `light` — force **black on white**: white surface, black text, light-grey tint.

Change it via `--theme`, `Ctrl+P` → **Theme** (panes), or `/theme` (REPL); it is
saved to the config file. Accents stay ANSI palette indices in both modes.

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

### Runtime invariants

- **Tool-only output.** Every model turn must validate against exactly one Zod schema.
  Invalid output is rejected and reported back as a protocol error; it is never
  silently reinterpreted.
- **No raw assistant text.** The only user-visible channel is `user(...)`.
- **File freshness.** Active files are re-read from disk before every inference. If
  conversation history conflicts with the current file context, the file context wins.
- **Single active task.** Only the top frame is executable. `bash`/`read`/`edit`/`pop`
  require a frame; in push mode only `push`/`user` are available.
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
