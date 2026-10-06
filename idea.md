# A Simple Stack-Driven LLM Coding Agent

## Overview

This proposal describes a minimal coding agent built around a small number of explicit runtime concepts:

- The model should always see the **latest version of relevant files**.
- File context should manage itself automatically using an **LRU working-set cache**.
- The agent should have only a few basic tools.
- Task execution should be represented explicitly as a **stack**.
- Planning and execution should be separate phases.
- The model should never silently stop in the middle of an unresolved frame.
- Conversation history, task state, and file state should be separate memory systems.
- The UI should expose these structures directly rather than hiding them.
- Stack transitions should be structured and suitable for prompting and self-prompting.
- The model should never emit uncontrolled assistant prose.
- Everything the model does, including talking to the user, should happen through explicit tools.

The result is a real autonomous coding agent with Aider-like context freshness, explicit task control, automatic memory management, and a fully runtime-controlled state machine.

---

# 1. Core Principle

Many coding agents mix several different kinds of state and output into one growing transcript:

```text
user request
assistant reasoning
file read
file contents
assistant prose
edit
new file contents
test output
more prose
tool call
final answer
...
```

This creates several problems:

- stale versions of files remain in context;
- old tool output consumes tokens;
- contradictory versions of source files may coexist;
- task state is implicit;
- agents can lose track of what they are actually doing;
- completion is often inferred from prose instead of machine state;
- it can be ambiguous whether assistant text means "continue", "stop", "ask", or merely "narrate".

Instead, this agent separates state into distinct memory domains and requires the model to interact with the world only through a tiny tool interface.

```text
┌───────────────────────────────┐
│ Conversation History          │
│ What happened                 │
└───────────────────────────────┘

┌───────────────────────────────┐
│ TODO Stack                    │
│ What must be handled now      │
└───────────────────────────────┘

┌───────────────────────────────┐
│ File LRU                      │
│ What code matters right now   │
└───────────────────────────────┘

┌───────────────────────────────┐
│ Filesystem                    │
│ What the code actually is     │
└───────────────────────────────┘
```

Each structure has one job.

---

# 2. The Model Only Calls Tools

The central runtime invariant is:

> **Every model turn must result in a tool call. The model never emits raw assistant text.**

The model's entire output language is:

```text
bash(...)
read(...)
edit(...)

push(...)
pop(...)

user(...)
```

There is no separate "normal assistant response".

Anything that should be visible to the user must go through:

```text
user(...)
```

This turns the agent into a much cleaner state machine.

The model proposes actions.

The runtime decides what those actions mean operationally.

---

# 3. Minimal Tool Surface

The complete model-facing tool surface is:

```text
bash(command)
read(path)
edit(path, patch)

push(description)
pop(description)

user(request)
```

These naturally divide into three groups.

## Environment

```text
bash()
read()
edit()
```

These inspect or modify the environment.

## Execution Control

```text
push()
pop()
```

These manipulate the task stack.

## Human Boundary

```text
user()
```

This is the only way to communicate directly with the user or yield control to them.

The semantics are:

```text
push() = I need to handle something before continuing this frame.

pop()  = This frame no longer needs to remain active.

user() = I need to communicate with or yield control to the human.
```

---

# 4. `bash(command)`

`bash()` provides general operating-system access.

Examples:

```text
bash("git status")
bash("rg 'refresh_token' src/")
bash("pytest tests/test_auth.py")
bash("git diff")
```

Bash output is an observation.

It does not automatically become persistent file context.

After the command returns, the runtime normally invokes the model again automatically with the command result.

---

# 5. `read(path)`

`read()` has stronger semantics than simply returning file contents.

It means:

> Bring this file into my active working memory.

Calling:

```text
read("src/auth.py")
```

does two things:

1. Returns the current contents of `src/auth.py`.
2. Promotes `src/auth.py` into the file LRU.

The LRU stores the **identity of the file**, not a snapshot of its contents.

Before every model inference, active files are reread from disk.

Therefore:

> A file present in the file context is always presented using its latest filesystem contents.

After `read()` completes, the runtime automatically invokes the model again.

---

# 6. `edit(path, patch)`

`edit()` modifies the filesystem.

Editing a file also promotes or refreshes that file in the file LRU.

```text
edit("src/auth.py", ...)
```

means that the next inference automatically receives the new version of `auth.py`.

After the edit result is available, the runtime invokes the model again.

---

# 7. The File LRU

The model does not manually `/add` and `/drop` files.

It simply reads what it needs.

```text
read(auth.py)
read(tokens.py)
read(test_auth.py)
```

The runtime maintains a bounded file working set.

For example:

```text
FILE LRU — 18.4k / 24k tokens

HOT
auth.py          4.2k
tokens.py        3.1k
test_auth.py     5.8k
routes.py        2.7k
config.py        2.6k
COLD
```

When the token budget is exceeded, the least recently used file is evicted.

Nothing is deleted from disk.

If the agent later needs the file again:

```text
read("config.py")
```

brings it back.

---

# 8. Token-Based Pressure

The cache should be bounded primarily by tokens rather than number of files.

A 100-line file and a 10,000-line generated file should not have equal cache cost.

Conceptually:

```text
file_context_tokens <= FILE_CONTEXT_BUDGET
```

Eviction continues until the active working set fits.

---

# 9. File Context Survives Task Transitions

The file LRU is independent from the task stack.

Suppose the agent is working on:

```text
Implement authentication flow
```

with:

```text
auth.py
user.py
```

in working memory.

It discovers a dependency and pushes:

```text
Fix token parser
```

During that task it reads:

```text
token.py
test_token.py
```

The working set becomes:

```text
auth.py
user.py
token.py
test_token.py
```

When the dependency is later popped and the parent resumes, the working set remains warm.

This produces smooth transitions between frames.

The task stack controls **what is being done**.

The file LRU controls **what code is currently useful**.

Their lifetimes are intentionally independent.

---

# 10. Conversation History

Conversation is another bounded memory region.

For a simple first implementation, conversation history can remain uncompressed.

No summarization is required.

When its token budget is exceeded, old conversation entries are evicted.

This keeps the system predictable:

```text
conversation = bounded raw history
files        = bounded live working set
tasks        = explicit stack
```

The runtime does not invent synthetic summaries.

---

# 11. Prompt Structure

Every inference is assembled from separate regions.

Conceptually:

```text
SYSTEM / AGENT RULES

TOOL DEFINITIONS

CONVERSATION HISTORY

TODO STACK

CURRENT FILE CONTEXT

CURRENT EVENT / OBSERVATION
```

The current file context is authoritative.

A system rule should explicitly state:

> If historical conversation or tool output conflicts with CURRENT FILE CONTEXT, the current file context is correct.

This prevents stale historical information from overriding the filesystem.

---

# 12. Stable Prompt Ordering

Prompt ordering should remain stable where possible so API prompt caching remains effective.

Logical LRU order does not need to equal serialized prompt order.

Internally:

```text
auth.py       touched 105
tokens.py     touched 103
routes.py     touched 91
config.py     touched 70
```

But files may still be serialized in a stable deterministic order.

LRU priority exists only for eviction decisions.

This separates:

```text
memory priority
```

from:

```text
prompt position
```

---

# 13. The TODO Stack

The agent's execution state is represented as a literal stack.

Example:

```text
┌───────────────────────────────────┐
│ Verify timezone conversion       │ ← TOP
├───────────────────────────────────┤
│ Patch expiry calculation          │
├───────────────────────────────────┤
│ Fix authentication regression     │
└───────────────────────────────────┘
```

Only the top-of-stack frame may be executed.

A frame represents:

> I NEED TO investigate, change, verify, decide, or resolve this before I can return to the frame underneath it.

This naturally handles discovered dependencies.

If the agent is doing A but discovers it must first do B:

```text
push(B)
```

If B requires C:

```text
push(C)
```

Execution becomes:

```text
A
  ↳ B
      ↳ C
```

Once C is closed:

```text
pop(C)
```

B becomes active again.

Then:

```text
pop(B)
```

and A resumes.

This gives the agent disciplined depth-first execution.

---

# 14. `push(description)` Means Enter a Task Frame

`push()` should take a structured description.

Its purpose is not merely to name a task.

It creates a self-prompt for the future model call.

A push frame should answer:

- Why does this task exist?
- What exactly is in scope?
- What is explicitly out of scope?
- What is currently known?
- What conditions allow this frame to be closed?

A recommended structure is:

```markdown
## Why

Explain why this frame exists.

What user request, parent task, dependency, uncertainty,
observation, or failure caused this task to be pushed?

## Scope

Describe exactly what this frame is responsible for.

Also state important boundaries:
what should not be changed or investigated as part of this frame?

## Known Context

Record the assumptions, facts, constraints, files, symptoms,
or observations that motivated the frame.

## Definition of Done

Describe the conditions under which this frame can be closed.

This does not necessarily mean successful implementation.
It means the responsibility represented by this frame
has reached a terminal state.
```

Example:

```text
push({
  why:
    "The authentication test fails only when refresh tokens are expired.
     The parent task needs to know whether timestamp parsing is responsible.",

  scope:
    "Inspect timestamp parsing and normalization only.
     Do not modify the authentication flow unless parsing is proven incorrect.",

  known_context:
    "The failure occurs after refresh_token() is entered.
     Parsed timestamps appear timezone-aware in logs.",

  definition_of_done:
    "Determine whether timestamp parsing is or is not the source of the failure,
     with enough evidence for the parent frame to decide what to do next."
})
```

The push description is both execution state and a prompt written by the model for its future self.

---

# 15. Definition of Done Does Not Mean Success

A frame's definition of done should define when the frame has been sufficiently resolved.

It should not imply that the initial hypothesis must be correct.

For example:

```text
Definition of done:

Determine whether the parser is responsible for the incorrect token expiry.
```

The frame can satisfy this by discovering either:

```text
Yes, the parser is broken.
```

or:

```text
No, the parser is correct.
```

Both are valid terminal outcomes.

A task frame represents a responsibility or question, not a promise that a particular solution will succeed.

---

# 16. `pop(description)` Means Close a Task Frame

`pop()` does **not** mean:

> This task succeeded.

It means:

> This frame is no longer active, and here is why.

A frame may be popped because it was:

- completed successfully;
- disproven;
- unnecessary;
- abandoned;
- blocked;
- superseded;
- invalidated by new evidence;
- partially completed;
- failed;
- or discovered to be the wrong direction.

This makes `pop()` a structured record of disposition.

A recommended pop description is:

```markdown
## Outcome

State what kind of outcome occurred.

Examples:
- completed
- disproven
- unnecessary
- abandoned
- superseded
- blocked
- failed
- partially completed

## What Was Done

Describe what was actually investigated, changed, tested,
or otherwise performed while the frame was active.

If nothing was changed, say so explicitly.

## Why This Frame Is Being Closed

Explain why it is now correct to remove this frame from the stack.

## Evidence / Observations

Record the important facts, commands, tests, files, measurements,
or discoveries that justify the disposition.

## Effects on Parent Task

Explain what the parent frame should now know.

This may include:
- files changed;
- assumptions invalidated;
- new facts;
- remaining risks;
- recommended next direction;
- or "none".
```

---

# 17. Example: Successful Completion

```text
pop({
  outcome:
    "completed",

  what_was_done:
    "Normalized parsed token timestamps to UTC and added regression coverage.",

  why_closed:
    "The identified timestamp mismatch has been corrected and verified.",

  evidence:
    "Targeted authentication tests and token tests pass.",

  effects_on_parent:
    "The authentication flow can now proceed using normalized expiry values."
})
```

---

# 18. Example: Wrong Direction

A frame can be useful even when its hypothesis was wrong.

```text
pop({
  outcome:
    "disproven",

  what_was_done:
    "Inspected timestamp parsing, reproduced parser output,
     and compared it against expected UTC values.",

  why_closed:
    "Timestamp parsing is correct, so continuing in this direction
     would waste effort.",

  evidence:
    "Parsed timestamps preserve timezone information and match expected values.",

  effects_on_parent:
    "The parent should investigate expiry comparison rather than parsing."
})
```

This is still a successful execution of the frame even though no code was changed.

---

# 19. Example: Changed Our Mind

```text
pop({
  outcome:
    "superseded",

  what_was_done:
    "Started investigating whether a database migration was required.",

  why_closed:
    "New evidence shows the existing schema already supports the required lookup.
     A migration would add unnecessary complexity.",

  evidence:
    "The existing index covers the queried columns.",

  effects_on_parent:
    "No database change is required."
})
```

The discarded direction remains documented.

---

# 20. Example: Nothing Was Done

Sometimes the model may push a frame and immediately discover it is unnecessary.

That is valid.

```text
pop({
  outcome:
    "unnecessary",

  what_was_done:
    "No filesystem changes were made.",

  why_closed:
    "The required capability already exists in the current implementation.",

  evidence:
    "The existing helper already performs the needed normalization.",

  effects_on_parent:
    "Reuse the existing helper instead of adding a new one."
})
```

This preserves an important fact:

> The agent considered this direction and deliberately rejected it.

---

# 21. `user(request)` Is the Only Human Boundary

The model does not emit ordinary assistant messages.

If it wants to:

- ask a question;
- report progress;
- explain a blocker;
- present choices;
- provide a recommendation;
- deliver a final result;
- tell the user that no action was needed;

it must call:

```text
user(...)
```

This means:

> Produce something visible to the user and yield control according to the request semantics.

This unifies questions and normal responses under one primitive.

---

# 22. Why `user()` Is Better Than Separate `ask()` and Assistant Text

Without `user()`, an agent often has two unrelated output channels:

```text
assistant prose
tool calls
```

The runtime then has to infer what prose means.

Was it:

- a final answer?
- a question?
- narration?
- progress?
- an accidental stop?
- a request for input?
- reasoning that should not have been shown?

With `user()`, that ambiguity disappears.

The model's output is always machine-readable.

```text
LLM output ∈ {
    bash,
    read,
    edit,
    push,
    pop,
    user
}
```

Anything outside that set is invalid.

---

# 23. Structured `user()`

A recommended schema is:

```text
UserRequest {
    message
    response
    choices?
    preferred_choice?
}
```

Where:

```text
response = "required" | "optional" | "none"
```

The runtime does not infer whether the user must answer.

The model states that explicitly.

---

# 24. `response: "required"`

This means:

> Show this message to the user and suspend automatic execution until the user responds.

Example:

```text
user({
  message:
    "Which behavior should the API use when the refresh token is expired?",

  response:
    "required",

  choices: [
    {
      id: "refresh",
      label: "Attempt automatic refresh",
      description:
        "Preserve the current session whenever possible."
    },
    {
      id: "reauth",
      label: "Require sign-in again",
      description:
        "Simpler and more explicit failure behavior."
    }
  ]
})
```

The current stack is unchanged.

The top frame remains active but enters a waiting state.

---

# 25. `response: "none"`

This means:

> Show this message to the user and do not wait for a reply as part of the current execution cycle.

Example:

```text
user({
  message:
    "The authentication fix is complete. The targeted tests and regression suite pass.",

  response:
    "none"
})
```

This is the normal final-report path.

The runtime yields control to the user.

---

# 26. `response: "optional"`

This means:

> Show this message to the user. A reply is welcome, but execution does not semantically depend on one.

This may be useful for notifications, observations, or checkpoints.

For a minimal v1, this mode could even be omitted and added later.

The essential distinction is between:

```text
required
```

and:

```text
none
```

---

# 27. User Choices

`user()` may optionally provide structured choices.

Example:

```text
user({
  message:
    "Which implementation should we use?",

  response:
    "required",

  choices: [
    {
      id: "minimal",
      label: "Minimal patch",
      description:
        "Smallest code change and lowest immediate risk."
    },
    {
      id: "refactor",
      label: "Refactor the abstraction",
      description:
        "Larger change but removes duplicated logic."
    }
  ]
})
```

The UI can render these as buttons, cards, radio options, or another native control.

Freeform user input should remain available unless explicitly disabled.

---

# 28. Model Preferences

The model may optionally recommend one of the proposed choices.

Example:

```text
user({
  message:
    "Which implementation should we use?",

  response:
    "required",

  choices: [
    {
      id: "minimal",
      label: "Minimal patch",
      description:
        "Smallest change and lowest immediate risk."
    },
    {
      id: "refactor",
      label: "Refactor the abstraction",
      description:
        "Larger change but removes duplicated logic."
    }
  ],

  preferred_choice: {
    id: "refactor",
    reason:
      "The duplicated logic already exists in three call sites,
       so centralizing it reduces future maintenance risk."
  }
})
```

The recommendation is explicit and justified rather than hidden in wording.

---

# 29. `user()` Does Not Necessarily Change the Stack

Calling:

```text
user(...)
```

does not inherently mean that the current frame is complete.

For example:

```text
user({
  message:
    "I need the production hostname before I can continue.",
  response:
    "required"
})
```

leaves the top frame active.

The state becomes:

```text
WAITING_FOR_USER
```

When the user responds, the same frame resumes.

This is different from:

```text
pop(...)
```

which actually removes the frame.

---

# 30. Pop and User Are Orthogonal

This distinction is important.

`pop()` changes task state.

`user()` changes who currently has control.

A common successful completion looks like:

```text
pop({
  outcome: "completed",
  ...
})
```

The runtime invokes the model again.

The model then calls:

```text
user({
  message:
    "Done. The bug was caused by timezone normalization and the regression tests now pass.",
  response:
    "none"
})
```

So:

```text
pop()  = close execution frame
user() = yield/report to human
```

These are separate concerns.

---

# 31. A Child Frame Can Pop Without Talking to the User

Suppose:

```text
A
  ↳ B
```

B is completed.

The model calls:

```text
pop(...)
```

The runtime removes B and invokes the model again with A active.

The model does **not** need to call `user()`.

It can immediately continue working on A.

This prevents unnecessary user interruptions.

---

# 32. The User Boundary Is Explicit

The automatic loop continues through all internal operations:

```text
bash()
read()
edit()
push()
pop()
```

Each of these normally causes the runtime to invoke the model again.

Only:

```text
user(...)
```

crosses the human boundary.

This creates a very strong invariant:

> **The model cannot terminate or suspend the agent loop by producing prose. Only `user()` can yield control to the human.**

---

# 33. Internal Operations vs Human Boundary

The tools fall into two runtime classes.

## Internal Operations

```text
bash
read
edit
push
pop
```

These return control to the runtime, which automatically re-enters the model.

Conceptually:

```text
LLM
 ↓
read()
 ↓
runtime
 ↓
filesystem
 ↓
runtime
 ↓
LLM
```

The user is not involved.

## Human Boundary

```text
user()
```

Conceptually:

```text
LLM
 ↓
user(...)
 ↓
runtime
 ↓
USER
```

If a response is required, the automatic loop pauses until the user responds.

---

# 34. Async Operations Are a Runtime Concern

Some environment operations may eventually be asynchronous.

For example:

```text
bash("long_running_build")
```

could later be modeled as a job with asynchronous completion.

That does not change the model-facing architecture.

The runtime decides whether a tool:

- returns immediately;
- blocks internally;
- creates an asynchronous job;
- or wakes the model later when a result arrives.

The model still only sees explicit tool calls and observations.

For a v1, environment tools can remain synchronous.

---

# 35. PUSH Mode

When a new user request arrives, the agent first enters **PUSH MODE**.

The model is asked to:

- understand the request;
- inspect existing task state;
- reason about the required work;
- determine the initial scope;
- write a structured push description;
- define clear closure conditions.

The result must be:

```text
push(TaskIntent)
```

The model does not answer the user directly during this phase unless the request genuinely requires immediate clarification, in which case it may use:

```text
user(... response="required")
```

Planning therefore becomes persistent machine state instead of disposable reasoning.

---

# 36. EXECUTION Mode

The model then enters execution mode.

It receives:

```text
conversation
todo stack
current top frame
file working set
tool results
```

It executes only the top frame.

Its available actions are:

```text
bash(...)
read(...)
edit(...)

push(...)
pop(...)

user(...)
```

There is no free-form output path.

---

# 37. Dependency Discovery

The stack creates a natural mechanism for dependency management.

Suppose the current task is:

```text
Implement authentication endpoint
```

During execution, the model discovers:

```text
The token representation must first be understood.
```

It pushes:

```text
push({
  why:
    "The authentication endpoint depends on token expiry semantics
     that are currently unclear.",

  scope:
    "Determine token expiry representation and comparison behavior.",

  known_context:
    "Authentication failures happen around expired refresh tokens.",

  definition_of_done:
    "The parent task has a clear and verified understanding of token expiry semantics."
})
```

The dependency immediately becomes the top of stack.

No global replan is required.

---

# 38. Anti-Procrastination Through Stack Discipline

The stack creates a useful behavioral property.

Agents frequently discover dependencies but continue wandering through the original task.

For example:

```text
"I need to inspect the schema first."
"I should probably update the migration."
"Maybe I should check the parser too."
```

A stack turns these thoughts into required control flow.

If it must happen first:

```text
push(it)
```

Then do it.

When the frame no longer needs to remain active:

```text
pop(with explanation)
```

The model cannot accumulate an ever-growing cloud of informal future intentions.

The system forces discovered prerequisites into execution.

In this sense, the stack acts as an anti-procrastination mechanism.

---

# 39. The Automatic Agent Loop

The runtime owns repeated model invocation.

Conceptually:

```text
while true:

    action = call_model()

    match action:

        bash:
            execute_command()
            continue

        read:
            read_file()
            update_file_lru()
            continue

        edit:
            apply_edit()
            update_file_lru()
            continue

        push:
            push_frame()
            continue

        pop:
            close_frame()
            record_disposition()
            continue

        user:
            show_to_user()

            if response == "required":
                suspend_until_user_reply()

            yield_control()
            break
```

The model never decides continuation through prose.

Continuation is derived entirely from tool semantics.

---

# 40. No Ambiguous Stopping

Without this architecture, a model can produce:

```text
I've made some progress. Next I should inspect the parser.
```

Then the runtime has to guess:

- Was that final?
- Should we call the model again?
- Did the model accidentally stop?
- Was it asking the user to wait?
- Is "next I should" a plan or an action?

In this architecture, that output is impossible.

The model must choose:

```text
read("parser.py")
```

or:

```text
push(...)
```

or:

```text
user(...)
```

or another explicit tool.

The state machine always knows what happens next.

---

# 41. Task States

A frame can be in a very small number of meaningful states:

```text
RUNNING
WAITING_FOR_USER
CLOSED
```

A frame becomes `WAITING_FOR_USER` only through:

```text
user(response="required")
```

A frame becomes `CLOSED` only through:

```text
pop(...)
```

Otherwise it remains `RUNNING`.

This makes runtime state explicit and inspectable.

---

# 42. User Interface

The internal architecture maps directly to an observable UI.

## Task Stack

The stack should visually look like a stack.

```text
┌───────────────────────────────────┐
│ VERIFY TOKEN EXPIRY FIX           │ ← TOP
│                                   │
│ Why                               │
│ Auth test fails on expired token. │
│                                   │
│ Scope                             │
│ Verify expiry comparison only.    │
│                                   │
│ Definition of Done                │
│ Determine whether comparison is   │
│ correct and provide evidence.     │
└───────────────────────────────────┘

┌───────────────────────────────────┐
│ Patch token expiry handling       │
└───────────────────────────────────┘

┌───────────────────────────────────┐
│ Fix authentication regression     │
└───────────────────────────────────┘
```

The top-of-stack frame remains expanded.

Lower frames may be collapsed.

The user always knows:

- why the current frame exists;
- what is currently in scope;
- what is not in scope;
- what the agent is trying to establish or change;
- what condition allows the frame to close.

---

# 43. Waiting-for-User UI

When the model calls:

```text
user(... response="required")
```

the top frame remains visible but changes state.

```text
┌───────────────────────────────────┐
│ IMPLEMENT AUTH BEHAVIOR           │
│ WAITING FOR USER                  │
│                                   │
│ Need decision                     │
│ Choose expired-token behavior.    │
└───────────────────────────────────┘
```

The UI can render the `user()` request directly:

```text
Which behavior should be used?

○ Attempt automatic refresh
  Preserve the session when possible.

● Require sign-in again
  Simpler and more explicit.

Recommended: automatic refresh
Reason: this matches existing session behavior.

[ Other: ________________________ ]
```

The agent is not "stuck".

It is explicitly waiting.

---

# 44. Popped Frames Become Execution History

Popped frames should move into an execution history together with their disposition.

For example:

```text
✓ Inspect timestamp parser
  Outcome: disproven
  Parser output is correct.
  Parent should inspect expiry comparison.

✓ Inspect database migration requirement
  Outcome: unnecessary
  Existing index already supports lookup.

▶ Verify expiry comparison
```

This documents both successful work and rejected directions.

It also helps prevent the agent or user from repeatedly revisiting already-investigated paths.

---

# 45. File Working-Set UI

The UI should expose the file LRU as well.

Example:

```text
FILE WORKING SET

18.4k / 24k tokens — 77% pressure

HOT
auth.py          4.2k
tokens.py        3.1k
test_auth.py     5.8k
routes.py        2.7k
config.py        2.6k
COLD
```

The user can see:

- which files the model currently has in working memory;
- how much context each file consumes;
- which files are hot or cold;
- when memory pressure is high;
- when an eviction occurs.

Example:

```text
read(models.py)

config.py evicted
23.6k / 24k tokens
```

Context management remains automatic but observable.

---

# 46. Different Memory Lifetimes

The system deliberately contains state with different lifetimes.

```text
Filesystem
    persistent source of truth

File LRU
    current coding working set

TODO Stack
    active execution state

Popped Frame History
    structured record of resolved directions

Conversation
    recent interaction history

Current inference
    transient computation
```

These should remain independent.

A frame ending should not clear file context.

A file eviction should not modify task state.

Conversation eviction should not alter the filesystem.

A `user()` call should not implicitly modify stack depth.

A discarded task should remain represented in popped-frame history through its disposition.

---

# 47. Important Invariants

The runtime should enforce a small set of strong invariants.

## Tool-Only Model Output

> Every model turn must result in exactly one valid tool action or another strictly defined tool protocol.

## No Raw Assistant Output

> User-visible text may only be emitted through `user()`.

## File Freshness

> Every active file shown to the model comes from the current filesystem.

## Single Active Task

> Only the top stack frame may be executed.

## Structured Dependency Discovery

> If another task must happen first, it is pushed.

## Structured Task Entry

> Every pushed frame contains why, scope, context, and a definition of done.

## Explicit Frame Closure

> A frame leaves the stack only through `pop()`.

## Pop Does Not Imply Success

> `pop()` means the frame is no longer active and records why.

## No Silent Abandonment

> Wrong directions, changed minds, blocked states, and unnecessary work are explicitly documented in the pop description.

## Explicit Human Boundary

> The agent can communicate with or yield to the user only through `user()`.

## Explicit User Wait

> Waiting for a required user response occurs only through `user(response="required")`.

## User Does Not Implicitly Change Stack State

> `user()` may suspend or yield execution, but it does not push or pop frames.

## Persistent Working Set

> Pushing, popping, or talking to the user does not clear the file LRU.

## Filesystem Authority

> Current file context overrides stale historical observations.

---

# 48. Minimal State Model

A first implementation can remain very small.

```text
AgentState {
    conversation: BoundedMessageQueue

    stack: [
        TaskFrame,
        ...
    ]

    popped_frames: [
        ClosedFrame,
        ...
    ]

    files: TokenBoundedLRU<Path>

    mode:
        PUSH
        EXECUTE
        WAITING_FOR_USER
}
```

A task frame:

```text
TaskFrame {
    why
    scope
    known_context
    definition_of_done
}
```

A task disposition:

```text
TaskDisposition {
    outcome
    what_was_done
    why_closed
    evidence
    effects_on_parent
}
```

A user request:

```text
UserRequest {
    message

    response:
        "required"
        | "optional"
        | "none"

    choices?: [
        {
            id
            label
            description
        }
    ]

    preferred_choice?: {
        id
        reason
    }
}
```

A closed frame:

```text
ClosedFrame {
    intent: TaskFrame
    disposition: TaskDisposition
}
```

---

# 49. Why Keep It Simple

The initial version does not need:

- embeddings;
- vector databases;
- automatic summaries;
- semantic memory;
- separate planner models;
- relevance-ranking models;
- complex DAG schedulers;
- autonomous context summarization;
- huge tool catalogs;
- separate question and answer protocols;
- heuristics for detecting whether assistant prose is "final".

The model already knows how to:

- inspect a repository;
- decide which file it needs;
- identify dependencies;
- break work into subtasks;
- reject bad hypotheses;
- change direction;
- ask meaningful questions;
- present choices;
- recommend an option;
- edit code;
- run tests;
- report results.

The runtime mainly needs to give those behaviors clean machine semantics.

---

# 50. The Agent as a Small Execution Machine

The architecture can be viewed as a tiny execution environment around the LLM.

```text
                    USER
                     ▲
                     │
                  user()
                     │
                     ▼
              ┌────────────┐
              │   RUNTIME  │
              └──────┬─────┘
                     │
                     ▼
                    LLM
              ┌──────┼──────┐
              │      │      │
            bash   read    edit
              │      │      │
              └──────┼──────┘
                     │
                 push / pop
                     │
                     ▼
                TODO STACK
```

The model is not a chat process that sometimes uses tools.

It is closer to a stochastic processor whose observable behavior is mediated entirely by a small syscall-like interface.

---

# 51. The Complete Instruction Set

The final minimal interface is:

```text
ENVIRONMENT
-----------

bash(command)
    Inspect or operate on the environment.

read(path)
    Read a file and promote it into the live file working set.

edit(path, patch)
    Modify a file and promote it into the live file working set.


EXECUTION CONTROL
-----------------

push(description)
    Enter a new task frame that must be handled before the current one can resume.

pop(description)
    Close the current frame and record why it is no longer active.


HUMAN INTERFACE
---------------

user(request)
    Send structured user-visible output and yield control according to
    whether a response is required.
```

Six primitives.

Each has one clear meaning.

---

# 52. The Result

The overall control flow becomes:

```text
                  USER REQUEST
                       │
                       ▼
                   PUSH MODE
                       │
                 push(TaskIntent)
                       │
                       ▼
                  TODO STACK
                       │
                       ▼
                 EXECUTION LOOP
        ┌──────────────┼──────────────┐
        │              │              │
      bash()          read()         edit()
        │              │              │
        └──────────────┼──────────────┘
                       │
                 push() / pop()
                       │
                       ▼
                     LLM
                       │
                       ├─────────────► continue internally
                       │
                       └─ user() ───► USER
```

The automatic loop continues through all internal actions.

The user only regains control through `user()`.

---

# 53. Final Mental Model

The architecture can be summarized as:

> **Chat records what happened.**  
> **The stack records what must be handled now.**  
> **Push records why a task became active.**  
> **Pop records why it stopped being active.**  
> **The file LRU records what matters right now.**  
> **The filesystem records what is true.**  
> **`user()` is the only boundary between the execution machine and the human.**

And the most important runtime property becomes:

> **The model never "just answers". It acts through a small instruction set, and the runtime always knows exactly what that action means.**