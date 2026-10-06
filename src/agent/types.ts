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
  | "protocol"

export type ConversationEntry = {
  id: string
  at: number
  role: ConversationRole
  text: string
  tokens: number
}

export type AgentState = {
  mode: AgentMode
  conversation: ConversationEntry[]
  stack: TaskFrame[]
  closedFrames: ClosedFrame[]
  files: FileEntry[]
  userRequest?: UserRequestRecord
}
