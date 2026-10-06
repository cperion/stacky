/**
 * Core domain types for the stack-driven agent.
 *
 * These mirror the state model in implementation.md §5–§9 and §48.
 */

export type AgentMode = "push" | "execute" | "waiting_for_user"

export type TaskFrame = {
  id: string
  why: string
  scope: string
  knownContext: string
  definitionOfDone: string
  createdAt: number
}

export type PopOutcome =
  | "completed"
  | "disproven"
  | "unnecessary"
  | "abandoned"
  | "superseded"
  | "blocked"
  | "failed"
  | "partial"

export type TaskDisposition = {
  outcome: PopOutcome
  whatWasDone: string
  whyClosed: string
  evidence: string
  effectsOnParent: string
  closedAt: number
}

export type ClosedFrame = {
  intent: TaskFrame
  disposition: TaskDisposition
}

export type UserResponseMode = "required" | "optional" | "none"

export type UserChoice = {
  id: string
  label: string
  description?: string
}

export type PreferredChoice = {
  id: string
  reason: string
}

export type UserRequest = {
  message: string
  response: UserResponseMode
  choices?: UserChoice[]
  preferredChoice?: PreferredChoice
}

export type UserRequestRecord = UserRequest & {
  id: string
  at: number
  resolved: boolean
  answer?: string
}

export type FileEntry = {
  path: string
  lastUsed: number
  tokenCount: number
  /** Assigned once on first promotion; used for stable prompt serialization order. */
  stableIndex: number
}

export type MaterializedFile = {
  path: string
  content: string
  tokens: number
  missing: boolean
}

export type ToolResult<T = unknown> = {
  ok: boolean
  value?: T
  error?: string
}

export type ConversationRole =
  | "user"
  | "agent"
  | "action"
  | "observation"
  | "thinking"
  | "note"
  | "protocol"
  | "subagent"

export type ConversationEntry = {
  id: string
  at: number
  role: ConversationRole
  text: string
  tokens: number
  /** Set on "action" entries: the tool that was called, for display. */
  tool?: string
  /** Set on "subagent" entries: how deep the subagent is and what it was saying. */
  depth?: number
  subrole?: ConversationRole
}

export type StreamingState = {
  active: boolean
  reasoning: string
  text: string
  tool?: string
  startedAt: number
  reasoningStartedAt?: number
  textStartedAt?: number
}

export type AgentState = {
  mode: AgentMode
  /** True while the automatic loop is running (model call or tool execution). */
  running: boolean
  /** Tool currently executing, if any. */
  activeTool?: string
  /** When the current phase (tool or model call) started, for elapsed feedback. */
  phaseStartedAt?: number
  /** Last line of a running command's output, for live feedback. */
  toolOutput?: string
  conversation: ConversationEntry[]
  stack: TaskFrame[]
  closedFrames: ClosedFrame[]
  files: FileEntry[]
  userRequest?: UserRequestRecord
  metrics: Metrics
  streaming?: StreamingState
}

export type Metrics = {
  llmCalls: number
  toolCalls: number
  pushes: number
  pops: number
  maxStackDepth: number
  filesPromoted: number
  filesEvicted: number
  protocolErrors: number
  userRequests: number
  subagents: number
  outcomes: Record<PopOutcome, number>
}

/** Serializable runtime state. File contents are never included — only paths. */
export type SessionSnapshot = {
  mode: AgentMode
  conversation: ConversationEntry[]
  stack: TaskFrame[]
  closedFrames: ClosedFrame[]
  filePaths: string[]
  userRequest?: UserRequestRecord
  metrics: Metrics
}
