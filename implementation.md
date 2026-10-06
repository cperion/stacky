# Implementation Plan — Stack-Driven Coding Agent

## 1. Goal

Build a minimal autonomous coding agent in:

- Bun
- TypeScript
- Vercel AI SDK
- OpenTUI Core
- Zod

The agent should:

- expose only a small fixed tool set;
- maintain an explicit task stack;
- maintain a token-bounded file LRU;
- always inject the latest version of active files;
- only communicate with the user through `user()`;
- automatically continue model execution after internal tool calls;
- never rely on raw assistant prose as control flow;
- show all important runtime state in a three-pane terminal UI.

---

# 2. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                         OpenTUI                             │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       Agent Runtime                         │
│                                                             │
│  Task Stack   File LRU   Conversation   Tool Dispatcher     │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         LLM Layer                           │
│                                                             │
│              Vercel AI SDK + provider adapters             │
└─────────────────────────────────────────────────────────────┘
```

The runtime owns the state machine.

The LLM only chooses actions.

---

# 3. Tool Instruction Set

The model may only call:

```text
bash(command)
read(path)
edit(path, patch)

push(description)
pop(description)

user(request)
```

There is no normal assistant text output.

Every model response must resolve to exactly one valid action.

---

# 4. Runtime Semantics

## Internal actions

These automatically trigger another model call after completion:

```text
bash()
read()
edit()
push()
pop()
```

## Human boundary

```text
user()
```

is the only tool that yields control to the human.

Example:

```text
user({
  message: "Which implementation should I use?",
  response: "required",
  choices: [...]
})
```

Execution pauses until the user replies.

A final response is also:

```text
user({
  message: "Done. Tests pass.",
  response: "none"
})
```

---

# 5. Core State

Start with a small explicit runtime state model.

```ts
type AgentState = {
  mode: AgentMode

  conversation: ConversationBuffer

  stack: TaskFrame[]

  closedFrames: ClosedFrame[]

  files: FileWorkingSet

  activity: ActivityEvent[]

  userRequest?: UserRequest
}
```

Modes:

```ts
type AgentMode =
  | "push"
  | "execute"
  | "waiting_for_user"
```

Avoid adding more modes until real use requires them.

---

# 6. Task Frame Model

A frame should be structured enough to act as a self-prompt.

```ts
type TaskFrame = {
  id: string

  why: string

  scope: string

  knownContext: string

  definitionOfDone: string

  createdAt: number
}
```

Only the top frame is executable.

---

# 7. `push()`

Schema:

```ts
type PushAction = {
  why: string
  scope: string
  knownContext: string
  definitionOfDone: string
}
```

Semantics:

```text
push(frame)
    ↓
append frame to stack
    ↓
new frame becomes TOS
    ↓
call model again
```

The description should explain:

- why the frame exists;
- what is in scope;
- what is outside the scope where relevant;
- what is already known;
- what allows the frame to be closed.

---

# 8. `pop()`

`pop()` means:

> This frame should no longer remain active.

It does not imply success.

Schema:

```ts
type PopAction = {
  outcome:
    | "completed"
    | "disproven"
    | "unnecessary"
    | "abandoned"
    | "superseded"
    | "blocked"
    | "failed"
    | "partial"

  whatWasDone: string

  whyClosed: string

  evidence: string

  effectsOnParent: string
}
```

On pop:

```text
TOS
 ↓
remove from active stack
 ↓
combine TaskFrame + PopAction
 ↓
append to ClosedFrame history
 ↓
call model again
```

A frame may therefore be closed because:

- the work succeeded;
- the hypothesis was wrong;
- the work was unnecessary;
- new evidence changed the plan;
- the agent is blocked;
- nothing needed to be changed.

---

# 9. `user()`

Schema:

```ts
type UserRequest = {
  message: string

  response:
    | "required"
    | "optional"
    | "none"

  choices?: UserChoice[]

  preferredChoice?: {
    id: string
    reason: string
  }
}
```

Choice:

```ts
type UserChoice = {
  id: string
  label: string
  description?: string
}
```

Semantics:

```text
user(response="required")
    ↓
render request
    ↓
pause runtime
    ↓
wait for human
    ↓
append response to conversation
    ↓
resume same TOS
```

For:

```text
response="none"
```

the runtime yields control without expecting an immediate reply.

---

# 10. File Working Set

The file cache stores paths, not snapshots.

```ts
type FileEntry = {
  path: string

  lastUsed: number

  tokenCount: number
}
```

The runtime should:

1. maintain a token budget;
2. promote a file on `read()`;
3. promote a file on `edit()`;
4. evict least-recently-used files when over budget;
5. reread every active file from disk before every inference.

The invariant is:

> Files in model context always represent the latest filesystem state.

---

# 11. File Prompt Ordering

LRU ordering should not determine serialization order.

Maintain:

```text
LRU order
```

for eviction.

Maintain a separate:

```text
stable prompt order
```

for serialization.

For example, sort active file paths deterministically.

This avoids unnecessarily invalidating prompt-cache prefixes when only recency metadata changes.

---

# 12. Conversation Buffer

Keep conversation management simple initially.

Use:

```text
bounded raw message history
```

Do not summarize.

Do not compact.

Do not create synthetic memories.

When the conversation exceeds its token budget:

```text
evict oldest retained entries
```

The initial implementation can be FIFO rather than true LRU.

---

# 13. Prompt Assembly

Every model call should be generated from explicit runtime state.

Conceptually:

```text
SYSTEM INSTRUCTIONS

TOOL DEFINITIONS

CONVERSATION HISTORY

ACTIVE TASK STACK

CURRENT FILE WORKING SET

LATEST EVENT / TOOL RESULT
```

The system prompt should state:

> Current file context is authoritative over stale conversation content.

And:

> The model must respond exclusively with one tool action.

---

# 14. Three-Pane TUI

The main UI should be a full-screen three-column layout.

```text
┌──────────────────┬────────────────────────────────┬──────────────────┐
│                  │                                │                  │
│   TASK STACK     │             CHAT               │     FILE LRU     │
│                  │                                │                  │
│   left pane      │          center pane           │    right pane    │
│                  │                                │                  │
└──────────────────┴────────────────────────────────┴──────────────────┘
```

Suggested proportions:

```text
Task Stack   25%
Chat         50%
File LRU     25%
```

The center pane should dominate because it is the primary human interaction surface.

---

# 15. Left Pane — Task Stack

The left pane renders the task stack literally as a stack.

The TOS is expanded.

Lower frames are compact.

Example:

```text
TASK STACK · depth 3

┌──────────────────────┐
│ Verify expiry logic  │  ← TOS
│                      │
│ Why                  │
│ Token test fails...  │
│                      │
│ Scope                │
│ Compare expiry only. │
│                      │
│ Done when            │
│ Cause is proven.     │
└──────────────────────┘

┌──────────────────────┐
│ Patch auth handling  │
└──────────────────────┘

┌──────────────────────┐
│ Fix auth regression  │
└──────────────────────┘
```

If the agent is waiting for user input:

```text
TOP · WAITING FOR USER
```

should be shown prominently.

---

# 16. TOS Display

The expanded top frame should always show:

```text
Why
Scope
Known Context
Definition of Done
```

This should match exactly what the model sees.

The UI must not maintain a separate summarized version of the active task.

The visible task state and model task state should be identical.

---

# 17. Center Pane — Chat

The center pane is the main interaction area.

It should contain:

- user messages;
- `user()` output;
- structured choices;
- final reports;
- relevant tool activity summaries.

Example:

```text
CHAT

You:
Fix the refresh token bug.

Agent:
I need a product decision before continuing.

Which behavior should expired refresh tokens use?

[1] Attempt automatic refresh
    Preserve the current session when possible.

[2] Require sign-in again
    Simpler and more explicit.

Recommended: 1
Matches the existing session behavior.

> _
```

The input field lives at the bottom of this pane.

---

# 18. Chat Should Not Show Raw Internal Prompt State

Do not dump:

- full stack frames;
- entire files;
- raw tool JSON;
- internal control objects;

into chat.

Those already have dedicated UI surfaces.

Chat should remain a human communication channel.

This is important because the architecture explicitly separates:

```text
chat
task state
file state
```

The UI should preserve the same distinction.

---

# 19. Tool Activity in Chat

Tool activity can appear as compact status entries.

Example:

```text
$ rg "refresh_token" src/
✓ 5 matches

read src/auth.ts
read src/token.ts

edited src/token.ts

$ bun test test/auth.test.ts
✓ 17 passed
```

These should be concise.

Detailed stdout can open in an expandable viewer later.

For v1, truncate large command output.

---

# 20. User Choices

When `user()` contains choices, render them natively in the center pane.

Example:

```text
Which implementation should we use?

  1. Minimal patch
     Lowest change risk.

> 2. Refactor abstraction   recommended
     Removes duplicated logic.

  3. Other...
```

Keyboard support:

```text
↑ / ↓     move
Enter     choose
e         enter freeform response
```

The choice system should still permit raw text input.

---

# 21. Right Pane — File Working Set

The right pane shows the active file LRU.

Example:

```text
FILE WORKING SET

18.4k / 24k
███████████████░░░░ 77%

HOT

auth.ts          4.2k
tokens.ts        3.1k
test-auth.ts     5.8k
routes.ts        2.7k
config.ts        2.6k

COLD
```

The ordering in the UI may be LRU order even though prompt serialization uses a different stable order.

The UI is showing cache priority, not prompt ordering.

---

# 22. Cache Pressure

Always expose:

```text
used tokens
budget
percentage
```

Example:

```text
18.4k / 24k · 77%
```

Later, add visual pressure states:

```text
< 70%     comfortable
70–90%    pressure
> 90%     eviction imminent
```

Do not make pressure thresholds affect runtime semantics initially.

They are only UI feedback.

---

# 23. Eviction Events

When a file is evicted, display a subtle event:

```text
evicted config.ts
```

The file should disappear from the working-set pane.

The event should also enter the activity log.

This helps debug context thrashing.

---

# 24. Closed Frame History

Do not keep closed frames inside the active stack.

Store them separately.

Initially, make them accessible through a keyboard shortcut such as:

```text
h
```

to open a temporary history overlay.

Example:

```text
FRAME HISTORY

✓ Inspect parser
  outcome: disproven

✓ Check migration requirement
  outcome: unnecessary

✓ Add regression test
  outcome: completed
```

Keep the main left pane dedicated to active frames.

---

# 25. UI Layout State

Suggested OpenTUI component structure:

```text
App
├── TaskStackPane
│   ├── TopFrame
│   └── ParentFrames
│
├── ChatPane
│   ├── Messages
│   ├── ChoicePrompt
│   └── Input
│
└── FilePane
    ├── PressureMeter
    └── FileList
```

Keep rendering state derived from `AgentState`.

Avoid duplicating agent state inside UI components.

---

# 26. Runtime Event Bus

Introduce a small event stream between runtime and UI.

Example:

```ts
type RuntimeEvent =
  | { type: "model.call.started" }
  | { type: "tool.started"; tool: string }
  | { type: "tool.finished"; tool: string }
  | { type: "frame.pushed"; frame: TaskFrame }
  | { type: "frame.popped"; frame: ClosedFrame }
  | { type: "file.promoted"; path: string }
  | { type: "file.evicted"; path: string }
  | { type: "user.request"; request: UserRequest }
```

The UI should subscribe to runtime state/events.

The runtime must not depend on OpenTUI.

---

# 27. Suggested Source Layout

```text
src/
├── main.ts
│
├── agent/
│   ├── runtime.ts
│   ├── state.ts
│   ├── loop.ts
│   ├── prompt.ts
│   └── events.ts
│
├── llm/
│   ├── client.ts
│   ├── models.ts
│   └── tools.ts
│
├── stack/
│   ├── stack.ts
│   ├── frame.ts
│   └── schemas.ts
│
├── files/
│   ├── lru.ts
│   ├── tokenizer.ts
│   └── context.ts
│
├── tools/
│   ├── bash.ts
│   ├── read.ts
│   ├── edit.ts
│   ├── push.ts
│   ├── pop.ts
│   └── user.ts
│
└── tui/
    ├── app.ts
    ├── task-pane.ts
    ├── chat-pane.ts
    ├── file-pane.ts
    ├── input.ts
    └── choices.ts
```

---

# 28. Implementation Phases

## Phase 1 — Runtime Skeleton

Implement:

```text
AgentState
TaskFrame
ClosedFrame
UserRequest
```

Implement an in-memory task stack.

No LLM yet.

Manually simulate:

```text
push
pop
user
```

Verify state transitions.

---

## Phase 2 — File LRU

Implement:

```text
read(path)
promotion
token counting
eviction
fresh materialization
```

Test:

```text
read A
read B
read C
touch A
read D
```

Verify the expected file is evicted.

---

## Phase 3 — Environment Tools

Implement:

```text
bash
read
edit
```

Keep them as ordinary async TypeScript functions.

Define a common tool-result envelope.

Example:

```ts
type ToolResult<T> = {
  ok: boolean
  value?: T
  error?: string
}
```

---

## Phase 4 — LLM Adapter

Create a tiny interface around Vercel AI SDK.

```ts
interface LLM {
  step(input: ModelInput): Promise<ModelAction>
}
```

The rest of the runtime should not depend directly on Vercel AI SDK APIs.

---

## Phase 5 — Tool-Only Model Contract

Define all six tools using strict schemas.

Validate every model action with Zod.

If the model produces invalid output:

```text
reject
inject protocol error
call model again
```

Do not silently reinterpret malformed actions.

---

## Phase 6 — Agent Loop

Implement:

```text
call model
execute action
update state
decide whether to loop or yield
```

Rules:

```text
bash → loop
read → loop
edit → loop
push → loop
pop → loop

user(required) → suspend
user(none) → yield
```

This is the core of the agent.

---

# 29. Phase 7 — Prompt Assembly

Build the prompt dynamically from:

```text
system rules
conversation
stack
fresh files
last observation
```

Add the critical invariants:

```text
Use only tools.
Never emit raw assistant text.
Only execute the top frame.
Use push for discovered prerequisites.
Use pop when a frame no longer belongs on the stack.
Use user when communicating with the human.
Current file context is authoritative.
```

---

# 30. Phase 8 — TUI Skeleton

Build the three-pane OpenTUI layout first.

Do not connect the LLM yet.

Render mocked state.

Target layout:

```text
┌───────────────┬──────────────────────────────┬───────────────┐
│ TASK STACK    │ CHAT                         │ FILE LRU      │
│               │                              │               │
│ TOS expanded  │ messages                     │ pressure      │
│ parents       │ choices                      │ hot → cold    │
│               │                              │               │
│               │                              │               │
│               │ > input                      │               │
└───────────────┴──────────────────────────────┴───────────────┘
```

Make resizing work early.

---

# 31. Phase 9 — Connect Runtime to UI

Connect `AgentState` and runtime events to the TUI.

Verify:

```text
push()
```

updates the left pane.

Verify:

```text
read()
```

updates the right pane.

Verify:

```text
user()
```

updates the center pane.

At this stage, the architecture should become visibly coherent.

---

# 32. Phase 10 — User Interaction

Implement:

```text
freeform chat input
choice selection
recommended choice marker
waiting state
```

When the runtime is in:

```text
WAITING_FOR_USER
```

the center input should submit directly as the response to the pending `user()` call.

---

# 33. Phase 11 — Real Repository Work

Point the agent at a small test repository.

Start with constrained tasks:

```text
find a failing test
fix one function
add one test
rename one API
```

Observe:

- stack depth;
- file-cache size;
- eviction behavior;
- number of LLM calls;
- frequency of unnecessary `push()`;
- frequency of unnecessary `user()` calls.

Do not optimize before collecting these traces.

---

# 34. Phase 12 — Persistence

After the runtime works reliably, persist:

```text
conversation
open stack
closed frame history
file LRU paths
```

Do not persist file contents.

On restart, active file paths should simply be materialized again from disk.

Possible storage:

```text
JSON file
```

first.

SQLite can come later if needed.

---

# 35. Logging

Keep a machine-readable execution trace.

Example:

```json
{
  "type": "frame.push",
  "frameId": "..."
}
```

```json
{
  "type": "tool.read",
  "path": "src/auth.ts"
}
```

```json
{
  "type": "frame.pop",
  "outcome": "disproven"
}
```

This will be essential when debugging agent behavior.

---

# 36. Metrics Worth Recording

From the beginning, record:

```text
LLM calls per user task

tool calls per task

push count

maximum stack depth

average frame lifetime

files read

file cache hit rate

file evictions

tokens in conversation

tokens in file context

user() calls requiring input

frames popped as:
  completed
  disproven
  abandoned
  blocked
  unnecessary
```

These will tell you whether the architecture is actually working as intended.

---

# 37. Things Not to Build Yet

Avoid adding:

```text
semantic memory
embeddings
vector search
subagents
parallel task execution
task DAGs
frame priorities
automatic summaries
complex permissions
remote execution
background jobs
multiple simultaneous user questions
plugin systems
```

The architecture's value comes from simplicity.

Test the six-instruction machine first.

---

# 38. First Milestone

The first meaningful milestone should be:

> Give the agent a small repository and a bug. It pushes a task frame, reads a few files, edits one, runs a test, pops the frame, and calls `user()` with the result.

The UI should visibly show:

```text
left:
task frame lifecycle

center:
conversation + final result

right:
file working-set evolution
```

If that feels smooth, the architecture is viable.

---

# 39. Second Milestone

Test dependency discovery.

Example:

```text
root frame
    ↓
agent discovers prerequisite
    ↓
push child
    ↓
child reads additional files
    ↓
pop child
    ↓
parent resumes
```

Verify that:

- the stack transition is correct;
- file context remains warm;
- parent execution resumes cleanly;
- the user is not unnecessarily interrupted.

---

# 40. Third Milestone

Test `user()` during an active frame.

Example:

```text
agent needs product decision
    ↓
user(response="required")
    ↓
TOS remains active
    ↓
UI enters WAITING FOR USER
    ↓
human chooses an option
    ↓
same frame resumes
```

This validates the full state machine.

---

# 41. Final V0 Architecture

```text
                           HUMAN
                             ▲
                             │
                           user()
                             │
                             ▼
┌────────────────────────────────────────────────────────────┐
│                       AGENT RUNTIME                        │
│                                                            │
│  Conversation     Task Stack       File LRU                │
│                                                            │
│                       │                                    │
│                       ▼                                    │
│                   Agent Loop                               │
│                       │                                    │
└───────────────────────┼────────────────────────────────────┘
                        │
                        ▼
                  LLM abstraction
                        │
                        ▼
                 Vercel AI SDK
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
       OpenAI       Anthropic       Google
```

UI:

```text
┌──────────────────┬────────────────────────────────┬──────────────────┐
│ TASK STACK       │ CHAT                           │ FILE WORKING SET │
│                  │                                │                  │
│ current intent   │ user conversation              │ token pressure   │
│ scope            │ model reports                  │ active files     │
│ done condition   │ questions / choices            │ LRU ordering     │
│ parent frames    │ tool activity                  │ eviction events  │
│                  │                                │                  │
└──────────────────┴────────────────────────────────┴──────────────────┘
```

The three panes directly expose the three important human-facing dimensions of the machine:

> **Left: what the agent is doing.**  
> **Center: what the agent and user are saying.**  
> **Right: what the agent currently knows about the code.**

That should be the visual identity of the project.