import { tool, type ToolSet } from "ai"
import {
  ACTION_SCHEMAS,
  bashSchema,
  editPatchSchema,
  popSchema,
  pushSchema,
  readSchema,
  todoSchema,
  userRequestSchema,
  type ToolName,
} from "../stack/schemas.ts"

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  bash: "Run a shell command in the workspace and observe its output. Use for search, inspection, tests, git, builds.",
  read: "Inspect/search/page a resource and promote a bounded view into LRU working context. Supply path for a current file/directory OR an exact resource ref. File/directory reads automatically pin applicable ancestor AGENTS.md instructions; nested rules apply only to their subtrees. Optional find is literal text. Follow returned refs, never guess them. LIVE file lines have editable anchors; historical/log views are read-only. Evicted content can be read back.",
  edit: 'Replace inclusive visible line anchors with {edits:[{from,through,text}]}; insert with {before,text} or {after,text}. All changes target one current file revision, with no overlapping or unseen lines. Returns refreshed views and new anchors. Compatibility: {path,edits:[{oldText,newText}]} uses the same visible-current guard; oldText="" creates a missing file.',
  push: "Enter a new task frame that must be handled before the current frame can resume. This is how you record a discovered prerequisite or a focused sub-investigation. It becomes the new top of stack.",
  spawn:
    "Delegate a self-contained sub-task to a fresh subagent with its own task stack and file working set. Use it to keep your own context clean when a sub-task is independent. The subagent runs to completion and returns a report.",
  pop: "Close the current top task frame and record why it is no longer active. pop() does NOT mean success — it records a disposition (completed, disproven, unnecessary, abandoned, superseded, blocked, failed, partial). Refused while any todo of the frame is still pending.",
  todo: "Mark a step (1-based) of the current frame's todo list as done or abandoned. pop() is refused until every step is resolved.",
  user: 'The ONLY way to produce user-visible output. Use response="required" to ask the human and suspend; response="none" to report a final result and yield.',
}

/**
 * Build AI SDK tool definitions for the allowed tool names.
 *
 * Tools have no `execute` function: the runtime owns execution and state
 * transitions, so the model call returns the tool call for us to dispatch.
 */
export function buildTools(allowed: readonly ToolName[]): ToolSet {
  const all: Record<ToolName, () => ToolSet[string]> = {
    bash: () => tool({ description: TOOL_DESCRIPTIONS.bash, inputSchema: bashSchema }),
    read: () => tool({ description: TOOL_DESCRIPTIONS.read, inputSchema: readSchema }),
    edit: () => tool({ description: TOOL_DESCRIPTIONS.edit, inputSchema: editPatchSchema }),
    push: () => tool({ description: TOOL_DESCRIPTIONS.push, inputSchema: pushSchema }),
    pop: () => tool({ description: TOOL_DESCRIPTIONS.pop, inputSchema: popSchema }),
    todo: () => tool({ description: TOOL_DESCRIPTIONS.todo, inputSchema: todoSchema }),
    spawn: () => tool({ description: TOOL_DESCRIPTIONS.spawn, inputSchema: pushSchema }),
    user: () => tool({ description: TOOL_DESCRIPTIONS.user, inputSchema: userRequestSchema }),
  }
  const tools: ToolSet = {}
  for (const name of allowed) tools[name] = all[name]()
  return tools
}

export { ACTION_SCHEMAS }
