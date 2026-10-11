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
EXECUTION CONTROL    push(taskFrame) · pop(disposition) · todo(step) · spawn(taskFrame)
HUMAN BOUNDARY       user(request)          <- the ONLY user-visible output
```

## Quick start

```bash
bun install

# Use it as a command from anywhere (links this working copy)
npm link
npx stacky --help        # or just: stacky --help

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
| `Enter` | send; accept a Tab-highlighted completion without sending |
| `Shift+Enter` / `Alt+Enter` | insert a newline in the three-row wrapping prompt |
| `Tab` / `Shift+Tab` | choose or cycle completions forward / backward |
| `Alt+↑` / `Alt+↓` | browse input history, preserving your unfinished draft |
| `↑` / `↓` | history at single-line buffer boundaries; otherwise move the cursor |
| `PageUp` / `PageDown` | scroll the transcript (panes) |
| `j` / `k` | move down / up through choices and menus |
| `h` / `l` | back / forward in menus; `l` selects a choice |
| `g` / `G` | jump to the top / bottom of a menu |
| `Esc` | close a menu; otherwise interrupt active work or dismiss completion — never erase a draft |
| `Ctrl+P` | command palette in REPL; settings menu in panes |
| `Ctrl+T` | toggle closed-frame history in the task pane |
| `Ctrl+C` | quit |

The TUI is vim-flavoured: `hjkl` drives every list and menu. While the chat
input has text, `j`/`k` are ordinary characters, so freeform replies still work;
the vim motions engage for the choice list only when the input is empty.

### Visual language

Contrast comes from **hierarchy**, not from hardcoded colours:

- Panes use dim (`ANSI 8`) borders and in-content headers with full-width rules;
  the chat border turns blue while working and yellow when it needs you.
- `▌` marks **user messages only**; agent prose is unmarked. `✻` marks thinking,
  `→` marks tool calls, and `│` is the thin gutter for secondary output.
  Neutral command output is not styled as a warning.
- Long text is hard-wrapped with the same indent on every line, so nothing turns
  ragged.
- The footer is a single line: a reverse-video mode chip, dim metadata, and a
  contextual keyboard hint. Completion and menu selections also use reverse video.
- Semantic colours are ANSI palette indices (red/green/yellow/blue/magenta/cyan),
  so they follow the terminal's own theme.

## Interfaces

Two interfaces share the same runtime and can be switched at runtime:

- **REPL** (default) — output flows into the terminal's real scrollback, and a
  pinned footer shows the live status, the current task, the context files and the
  prompt, like a shell.
- **Panes** (`--ui panes`) — an alternate-screen layout that adapts to the terminal:
  three columns at 116+ columns, task + chat at 84–115, chat only below 84.
  `/task` and `/files` expose the full context even when sidebars are hidden.

The REPL footer is the always-visible state surface:

```
stacky  ·  REPL mode. Type a task, or /help for commands.
▌ fix the failing test
✻ Thinking
│ The failure is in the token parser, so I should read it first.
→ read  src/token.ts
│ token.ts · 84 lines

TASK   Fix token expiry parsing
·      Fix the expiry comparison
FILES  2 · 7.0k / 24.0k tokens · src/token.ts · tests/token.test.ts
❯ _


 READY   deepseek/deepseek-flash   Tab complete · ⇧Enter newline · /help
```

Above the dashboard sits a two-row **history stripe**: one cell per *resolved* frame
(title + outcome). The open stack is the dashboard's job, so nothing is shown twice.

The dashboard shows the task title, pending checklist, parent stack and file
summary. It is bounded to a third of the terminal, with an explicit overflow
hint; `/task` shows the full Why/Scope/Known/Done/checklist and `/files` lists every
context path. Empty sections disappear, and `/dashboard off` hides the entire
panel. The three-row prompt is stable; only completion temporarily expands it.

The status bar leads with a compact **state chip** — `READY` (idle at the prompt),
`PLAN` (framing), `RUN` (executing), `THINK` (streaming reasoning), `WRITE` (streaming
answer), `TOOL <name> <elapsed>` (running a tool), `WAIT ·choice|·reply` (needs you) — and it
shows elapsed seconds / tokens-per-second while a phase runs. The status meta is
deliberately small (model and reasoning setting); `/status` owns call counters. Each coloured chip uses an **explicit contrasting fg/bg
pair** (dark text on bright bars, bright-white text on dark bars) so it reads well on
any theme; `READY`/`IDLE` invert the terminal's own fg/bg. Long command output streams
live above the prompt while `bash` runs. The status line and dashboard summaries
fit the available width instead of pushing controls offscreen.

Both interfaces use the same composer. Typing `/` shows command descriptions;
command arguments complete too. Type `/model sonnet` to filter across providers,
then Tab to choose and Enter to accept. A second Enter runs the command (a unique
Tab match fills immediately, so only one Enter is needed). Model
lists refresh in the background, with cached/unverified/authentication labels.
Busy submission keeps your draft rather than discarding it. In the REPL,
`Ctrl+P` opens a command palette and restores your draft on Escape or after a
command runs. Slash commands include:

```
/help                 list commands
/model [provider/id]  show or choose a model; /model refresh forces discovery
/task                 full task stack and checklist
/files                all context files
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

Markers are consistent: the big `▌` block is reserved for **your messages** (with the
tint), `│` is the thin gutter for tool output / thinking / code, `✻` marks thinking, and
`→` marks tool calls. Agent prose is unmarked.

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

In panes, press `Ctrl+P` for the settings menu (vim keys: `j`/`k` move, `l`/Enter select,
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

The **Model** submenu groups models by provider. Opening a provider fetches its
list with a visible loading state; errors remain in the menu rather than closing
it. Cached or unverified fallback lists are labelled. Selecting a model rebuilds
the client and persists the choice. Switching during a turn is refused without
mutating settings; missing credentials and failed switches have actionable errors. `Thinking` maps to the provider-agnostic
`reasoning` setting (`'none'` vs `'provider-default'`); DeepSeek V4 models think by
default, so it is disabled explicitly unless you turn it on.

Settings persist to `${XDG_CONFIG_HOME:-~/.config}/stacky/config.json` (override with
`STACKY_CONFIG` or `--config`). Only paths and preferences are stored — never file
contents.

### ChatGPT subscription (OAuth)

Run against a ChatGPT plan instead of an OpenAI API key:

```bash
stacky
/login chatgpt                 # opens the browser, then stores tokens
/model chatgpt/gpt-5-codex
```

- Tokens live in `~/.config/stacky/auth.json` (mode `0600`) and refresh
  transparently; set `STACKY_AUTH` to override the path. `/logout chatgpt`
  removes them.
- This is OAuth against the ChatGPT backend (Responses API), **not**
  `api.openai.com` — no API key is needed or used. `chatgpt` is a provider like
  any other, so `/model`, tab completion and `--provider chatgpt` all work.

### Model lists are fetched, not hardcoded

`/model` asks each provider for *its* model list (including the ChatGPT backend
under OAuth), ranks known ids first, and caches the result in memory and in
`~/.config/stacky/models.json` for 10 minutes. Each provider is labelled with
where its list came from — provider, cached, unverified fallback, or missing credentials —
so you can tell fresh from stale. `/model refresh` forces a re-fetch; the
built-in catalog is only used when a provider is unreachable.

## CLI

```
--task <text>              initial task
--mock                     offline demo model (no API key)
--headless                 stream events to stdout instead of the TUI
--provider <name>          openai | anthropic | deepseek | chatgpt (default: deepseek)
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
- **A frame is a checklist.** Every frame carries a short `title` and an ordered
  `todos` list. `pop` is **refused while any step is still pending** — resolve each
  with `todo({index, status:"done"})` or `todo({index, status:"abandoned", note})`.
  This makes the plan concrete and the UI show real progress.
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
