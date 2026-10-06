import type { AgentMode, ConversationEntry, MaterializedFile, TaskFrame, UserRequestRecord } from "./types.ts"
import type { ToolName } from "../stack/schemas.ts"
import { TOOL_DESCRIPTIONS } from "../llm/tools.ts"

export const SYSTEM_RULES = `You are a stack-driven coding agent. You operate ONLY by calling tools.

## Absolute output contract
- Every turn you MUST call exactly one tool. Never emit plain assistant text.
- Anything a human should see must go through user(...). There is no other output channel.
- The runtime executes your tool call and calls you again automatically. You never need to say "continue".

## Tool semantics
- bash(command): inspect or operate on the environment. Output is an observation, not persistent file context.
- read(path): read a file AND bring it into your live file working set.
- edit(path, edits): modify a file by exact-text replacement. Also refreshes the file in the working set. You MUST read(path) first — edit() is refused for an existing file that is not in your working set.
- push({why, scope, knownContext, definitionOfDone}): enter a new task frame. It becomes the TOP of the stack and runs before the current frame resumes. Use this whenever you discover a prerequisite.
- spawn({why, scope, knownContext, definitionOfDone}): delegate a self-contained sub-task to a fresh subagent with its own task stack and file working set. Use it to keep your own context clean; the subagent runs to completion and returns a report.
- pop({outcome, whatWasDone, whyClosed, evidence, effectsOnParent}): close the TOP frame and record why. pop() does NOT mean success. Valid outcomes: completed, disproven, unnecessary, abandoned, superseded, blocked, failed, partial. Never abandon a direction silently.
- user({message, response, choices?, preferredChoice?}): the only human boundary. response="required" suspends until the human answers; response="none" reports and yields.

## Execution discipline
- Only the TOP task frame may be executed.
- Read a file before editing it. Editing an existing file that is not in your working set is refused; call read(path) first, then edit the current contents.
- If something must happen before the current frame can proceed, push() it. Do not accumulate informal intentions.
- A frame's definition of done describes when the responsibility is resolved, not when the initial hypothesis is proven. Popping with outcome="disproven" is a successful frame execution.
- Do not call pop() on a frame you have not actually worked; if nothing was needed, say so with whatWasDone and the appropriate outcome.
- When the stack is empty and the work is finished, call pop() on the last frame if any, then user({response:"none"}) with the final report.
- Use user({response:"required"}) only when you genuinely cannot proceed without a human decision.

## File freshness
- CURRENT FILE WORKING SET below is authoritative. Always re-read it as the truth.
- If historical conversation or tool output conflicts with the current file context, the current file context is correct.

## Planning
- In PUSH mode the only tools available are push(...) and user(...). Establish the initial frame BEFORE inspecting or changing anything: understand the request, then call push(...).
- In EXECUTE mode, work only on the top frame. Inspect, edit, and verify there.`

export function buildSystemPrompt(allowed: readonly ToolName[]): string {
  const listing = allowed.map((name) => `- ${name}: ${TOOL_DESCRIPTIONS[name]}`).join("\n")
  return `${SYSTEM_RULES}\n\n## Tools available right now (${allowed.join(", ")})\n${listing}`
}

export type PromptInput = {
  mode: AgentMode
  depth?: number
  conversation: readonly ConversationEntry[]
  stack: readonly TaskFrame[]
  files: readonly MaterializedFile[]
  fileBudgetTokens: number
  fileUsedTokens: number
  observation: string
  userRequest?: UserRequestRecord
}

export function buildUserPrompt(input: PromptInput): string {
  const sections: string[] = []

  if ((input.depth ?? 0) > 0) {
    sections.push(
      `# SUBAGENT (depth ${input.depth})\nYou are a subagent with your own task stack and file working set. You cannot ask the user. When the work is done, close your frames and finish with user({response:"none"}) carrying a concise report for your parent.`,
    )
  }

  sections.push(renderConversation(input.conversation))
  if (input.userRequest) sections.push(renderUserRequest(input.userRequest))
  sections.push(renderStack(input.stack, input.mode))
  sections.push(renderFiles(input.files, input.fileUsedTokens, input.fileBudgetTokens))
  if (input.observation.trim().length > 0) {
    sections.push(`# LATEST EVENT\n${input.observation.trim()}`)
  }
  sections.push(`# YOUR MOVE\nCall exactly one tool now.`)

  return sections.join("\n\n")
}

function renderConversation(entries: readonly ConversationEntry[]): string {
  const visible = entries.filter((entry) => entry.role !== "thinking" && entry.role !== "note" && entry.role !== "subagent")
  if (visible.length === 0) return "# CONVERSATION\n(empty)"
  const lines = visible.map((entry) => `[${entry.role}] ${entry.text}`)
  return `# CONVERSATION (${visible.length} entries)\n${lines.join("\n")}`
}

function renderUserRequest(request: UserRequestRecord): string {
  const lines: string[] = ["# PENDING USER REQUEST"]
  lines.push(`Question: ${request.message}`)
  lines.push(`Response mode: ${request.response}`)
  if (request.choices && request.choices.length > 0) {
    lines.push("Choices:")
    for (const choice of request.choices) {
      const recommended = request.preferredChoice?.id === choice.id ? " [recommended]" : ""
      lines.push(`- ${choice.id}: ${choice.label}${recommended}`)
    }
  }
  if (request.resolved) {
    lines.push(`Status: RESOLVED — the human answered: ${request.answer ?? "(no answer recorded)"}`)
  } else {
    lines.push("Status: UNRESOLVED — the human has not answered yet.")
  }
  return lines.join("\n")
}

function renderStack(stack: readonly TaskFrame[], mode: AgentMode): string {
  if (stack.length === 0) {
    return `# TODO STACK (empty, mode=${mode})\nNo frame is active. If you are responding to a request, push(...) the initial frame now.`
  }
  const top = stack[stack.length - 1]!
  const parents = stack.slice(0, -1)
  const lines: string[] = [`# TODO STACK (depth ${stack.length}, mode=${mode})`]

  if (parents.length > 0) {
    lines.push(`## PARENT FRAMES (not executable until the top frame is popped)`)
    for (let i = parents.length - 1; i >= 0; i--) {
      const frame = parents[i]!
      lines.push(`- ${frame.why.split("\n")[0]}`)
    }
  }

  lines.push(`## TOP FRAME${mode === "waiting_for_user" ? " (WAITING FOR USER)" : " (execute this one)"}`)
  lines.push(frameBlock(top))
  return lines.join("\n")
}

export function frameBlock(frame: TaskFrame): string {
  return [
    `Why: ${frame.why}`,
    `Scope: ${frame.scope}`,
    `Known Context: ${frame.knownContext || "(none recorded)"}`,
    `Definition of Done: ${frame.definitionOfDone}`,
  ].join("\n")
}

function renderFiles(files: readonly MaterializedFile[], used: number, budget: number): string {
  if (files.length === 0) return "# CURRENT FILE WORKING SET\n(empty)"
  const header = `# CURRENT FILE WORKING SET (${files.length} files, ~${used} / ${budget} tokens)`
  const blocks = files.map((file) => {
    if (file.missing) return `## ${file.path}\n(file is missing on disk)`
    return `## ${file.path}\n\`\`\`\n${file.content}\n\`\`\``
  })
  return [header, ...blocks].join("\n\n")
}
