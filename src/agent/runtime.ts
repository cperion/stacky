import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import type { ModelAction, PopAction, PushAction, ToolName, UserRequestAction } from "../stack/schemas.ts"
import type {
  AgentMode,
  AgentState,
  ClosedFrame,
  Metrics,
  SessionSnapshot,
  StreamingState,
  UserRequestRecord,
} from "./types.ts"
import { TaskStack } from "../stack/stack.ts"
import { ConversationBuffer } from "./conversation.ts"
import { FileWorkingSet, resolvePath } from "../files/lru.ts"
import { EventBus, type RuntimeEvent } from "./events.ts"
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts"
import { ProtocolError, type LLMClient, type ModelInput, type StreamHandlers } from "../llm/client.ts"
import { createMetrics } from "./metrics.ts"
import { describeToolCall } from "./format-action.ts"
import { runBash } from "../tools/bash.ts"
import { runRead } from "../tools/read.ts"
import { runEdit } from "../tools/edit.ts"

export type AgentRuntimeOptions = {
  cwd: string
  llm: LLMClient
  bus?: EventBus
  fileBudgetTokens?: number
  conversationBudgetTokens?: number
  maxProtocolErrors?: number
  maxStepsPerRun?: number
  maxStackDepth?: number
  /** Nesting level: 0 for the top-level agent, 1+ for subagents. */
  depth?: number
  /** How deep subagents may nest. */
  maxDepth?: number
  /** Subagents may not ask the human a question; they report instead. */
  allowUser?: boolean
}

const MODE_TOOLS: Record<AgentMode, ToolName[]> = {
  // Planning is separate from execution: establish a frame before inspecting or changing anything.
  push: ["push", "user"],
  execute: ["bash", "read", "edit", "push", "pop", "spawn", "user"],
  waiting_for_user: [],
}

/**
 * Owns the agent state machine. The model only chooses actions; the runtime
 * decides what they mean, always calling the model again after internal
 * operations and yielding only at the user() boundary.
 */
export class AgentRuntime {
  readonly bus: EventBus
  readonly cwd: string
  readonly metrics: Metrics = createMetrics()

  private llm: LLMClient
  private stack = new TaskStack()
  private conversation: ConversationBuffer
  private files: FileWorkingSet
  private closedFrames: ClosedFrame[] = []

  private mode: AgentMode = "push"
  private userRequest?: UserRequestRecord
  private observation = ""
  private running = false
  private activeTool?: string
  private activeToolSince?: number
  private toolStream = ""
  private protocolErrors = 0
  private streaming?: StreamingState
  private abortController?: AbortController

  private readonly maxProtocolErrors: number
  private readonly maxStepsPerRun: number
  private readonly maxStackDepth: number
  readonly depth: number
  private readonly maxDepth: number
  private readonly allowUser: boolean
  private report?: string

  constructor(opts: AgentRuntimeOptions) {
    this.cwd = opts.cwd
    this.llm = opts.llm
    this.bus = opts.bus ?? new EventBus()
    this.conversation = new ConversationBuffer(opts.conversationBudgetTokens ?? 32_000)
    this.files = new FileWorkingSet({ cwd: opts.cwd, budgetTokens: opts.fileBudgetTokens ?? 24_000 })
    this.maxProtocolErrors = opts.maxProtocolErrors ?? 3
    this.maxStepsPerRun = opts.maxStepsPerRun ?? 80
    this.maxStackDepth = opts.maxStackDepth ?? 16
    this.depth = opts.depth ?? 0
    this.maxDepth = opts.maxDepth ?? 2
    this.allowUser = opts.allowUser ?? true
  }

  get isRunning(): boolean {
    return this.running
  }

  get isWaitingForUser(): boolean {
    return this.mode === "waiting_for_user"
  }

  get llmLabel(): string {
    return this.llm.label
  }

  get isStreaming(): boolean {
    return this.streaming?.active === true
  }

  /** A subagent's final report (its last user(response:none) message). */
  get lastReport(): string | undefined {
    return this.report
  }

  private addEntry(
    role: Parameters<ConversationBuffer["add"]>[0],
    text: string,
    meta?: Parameters<ConversationBuffer["add"]>[2],
  ): void {
    const entry = this.conversation.add(role, text, meta)
    this.bus.emit({ type: "conversation.added", entry })
  }

  /**
   * Interrupt the in-flight model call at the API level (aborts its stream).
   * Returns true if a call was actually in flight.
   */
  interrupt(): boolean {
    if (!this.abortController) return false
    this.abortController.abort()
    return true
  }

  /** Swap the model. Only allowed while idle, so a turn is never interrupted. */
  setLLM(llm: LLMClient): void {
    if (this.running) throw new Error("Cannot switch models while the agent is running.")
    this.llm = llm
    this.emitState()
  }

  /** Update context budgets at runtime (the config menu uses this). */
  setBudgets(budgets: { fileBudgetTokens?: number; conversationBudgetTokens?: number }): string[] {
    let evicted: string[] = []
    if (budgets.fileBudgetTokens !== undefined) {
      evicted = this.files.setBudget(budgets.fileBudgetTokens)
      for (const path of evicted) this.bus.emit({ type: "file.evicted", path })
    }
    if (budgets.conversationBudgetTokens !== undefined) {
      this.conversation.setBudget(budgets.conversationBudgetTokens)
    }
    this.emitState()
    return evicted
  }

  /** Clear task state, history and the working set. Keeps the model and metrics. */
  reset(): void {
    if (this.running) throw new Error("Cannot reset while the agent is running.")
    this.stack.clear()
    this.conversation.clear()
    this.files.clear()
    this.closedFrames = []
    this.userRequest = undefined
    this.observation = ""
    this.streaming = undefined
    this.protocolErrors = 0
    this.mode = "push"
    this.emitState()
  }

  snapshot(): AgentState {
    return {
      mode: this.mode,
      running: this.running,
      ...(this.activeTool ? { activeTool: this.activeTool } : {}),
      ...((this.activeToolSince ?? this.streaming?.startedAt)
        ? { phaseStartedAt: this.activeToolSince ?? this.streaming?.startedAt }
        : {}),
      ...(this.activeTool === "bash" && this.toolStream
        ? { toolOutput: this.toolStream.split("\n").filter((line) => line.trim().length > 0).at(-1) ?? "" }
        : {}),
      conversation: [...this.conversation.entries()],
      stack: [...this.stack.list()],
      closedFrames: [...this.closedFrames],
      files: this.files.list(),
      userRequest: this.userRequest,
      metrics: { ...this.metrics, outcomes: { ...this.metrics.outcomes } },
      ...(this.streaming ? { streaming: { ...this.streaming } } : {}),
    }
  }

  /** Serializable state. Contains file paths only, never contents. */
  exportSession(): SessionSnapshot {
    return {
      mode: this.mode,
      conversation: [...this.conversation.entries()],
      stack: [...this.stack.list()],
      closedFrames: [...this.closedFrames],
      filePaths: this.files.stableOrder().map((entry) => entry.path),
      ...(this.userRequest ? { userRequest: this.userRequest } : {}),
      metrics: { ...this.metrics, outcomes: { ...this.metrics.outcomes } },
    }
  }

  /** Surface an out-of-band error to the conversation without changing mode. */
  notify(message: string): void {
    this.addEntry("protocol", message)
    this.bus.emit({ type: "fatal", message })
    this.emitState()
  }

  /** Add a neutral system note to the transcript (UI/command output). */
  note(message: string): void {
    this.addEntry("note", message)
    this.emitState()
  }

  /**
   * Restore a persisted session. File contents are re-materialized from disk
   * on the next inference, so a restart cannot resurrect stale code.
   */
  importSession(data: SessionSnapshot): void {
    this.conversation.restore(data.conversation ?? [])
    this.stack.restore(data.stack ?? [])
    this.closedFrames = [...(data.closedFrames ?? [])]
    this.files.restore(data.filePaths ?? [])
    this.observation = ""
    this.streaming = undefined
    this.userRequest = data.userRequest
    if (data.metrics) Object.assign(this.metrics, data.metrics, { outcomes: { ...data.metrics.outcomes } })

    const waiting =
      this.userRequest !== undefined && !this.userRequest.resolved && this.userRequest.response === "required"
    this.mode = waiting ? "waiting_for_user" : this.stack.isEmpty ? "push" : "execute"
    this.emitState()
  }

  /** External human input. Resumes a suspended frame, or starts a new request. */
  async request(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return

    if (this.mode === "waiting_for_user" && this.userRequest) {
      const record = this.userRequest
      record.resolved = true
      record.answer = trimmed
      this.bus.emit({ type: "user.resolved", request: record })
      this.addEntry("user", trimmed)
      this.userRequest = undefined
      this.mode = this.stack.isEmpty ? "push" : "execute"
      this.emitState()
      await this.run()
      return
    }

    if (this.running) {
      // The UI should not allow this, but never lose the input silently.
      throw new Error("Agent is already running; wait for it to yield before sending input.")
    }

    this.addEntry("user", trimmed)
    this.mode = this.stack.isEmpty ? "push" : "execute"
    this.emitState()
    await this.run()
  }

  /** The automatic agent loop. Runs until a user boundary or a hard stop. */
  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    this.emitState()
    try {
      let steps = 0
      while (steps < this.maxStepsPerRun) {
        if (this.mode === "waiting_for_user") break
        steps += 1

        const result = await this.invokeModel()
        if (result.kind === "stop") return
        if (result.kind === "continue") continue

        const shouldContinue = await this.dispatch(result.action)
        if (!shouldContinue) return
      }
      this.fail(`Step limit reached (${this.maxStepsPerRun}) without reaching a user boundary.`)
    } finally {
      this.running = false
      this.emitState()
    }
  }

  // ---------------------------------------------------------------------------
  // Model invocation
  // ---------------------------------------------------------------------------

  private async invokeModel(): Promise<
    { kind: "action"; action: ModelAction } | { kind: "continue" } | { kind: "stop" }
  > {
    const allowedTools = this.allowedTools()
    const input: ModelInput = {
      system: buildSystemPrompt(allowedTools),
      prompt: buildUserPrompt({
        mode: this.mode,
        depth: this.depth,
        conversation: this.conversation.entries(),
        stack: this.stack.list(),
        files: this.files.materialize(),
        fileBudgetTokens: this.files.budgetTokens,
        fileUsedTokens: this.files.totalTokens(),
        observation: this.observation,
        ...(this.userRequest ? { userRequest: this.userRequest } : {}),
      }),
      allowedTools,
      mode: this.mode,
    }

    this.metrics.llmCalls += 1
    this.bus.emit({ type: "model.call.started", mode: this.mode })

    this.streaming = { active: true, reasoning: "", text: "", startedAt: Date.now() }
    this.emitState()

    const handlers: StreamHandlers = {
      onReasoningDelta: (delta) => {
        if (!this.streaming) return
        if (!this.streaming.reasoningStartedAt) this.streaming.reasoningStartedAt = Date.now()
        this.streaming.reasoning += delta
        this.emitState()
      },
      onTextDelta: (delta) => {
        if (!this.streaming) return
        if (!this.streaming.textStartedAt) this.streaming.textStartedAt = Date.now()
        this.streaming.text += delta
        this.emitState()
      },
      onToolStart: (tool) => {
        if (!this.streaming) return
        this.streaming.tool = tool
        this.emitState()
      },
    }

    let action: ModelAction | undefined
    let failure: unknown
    const controller = new AbortController()
    this.abortController = controller
    try {
      action = await this.llm.step(input, handlers, controller.signal)
    } catch (error) {
      failure = error
    }
    this.abortController = undefined

    // User interruption: discard the partial turn and yield control.
    if (controller.signal.aborted) {
      this.streaming = undefined
      this.bus.emit({ type: "model.call.aborted" })
      this.addEntry("note", "interrupted by user")
      this.emitState()
      return { kind: "stop" }
    }

    // Move any streamed reasoning into the conversation regardless of outcome.
    const reasoning = this.takeStreamedReasoning()
    if (reasoning) this.addEntry("thinking", reasoning)
    this.emitState()

    if (!failure && action) {
      this.bus.emit({ type: "model.call.finished", tool: action.tool })
      return { kind: "action", action }
    }

    const error = failure
    if (error instanceof ProtocolError) {
      this.protocolErrors += 1
      this.metrics.protocolErrors += 1
      const message = `PROTOCOL ERROR: ${error.message}`
      this.observation = message
      this.addEntry("protocol", message)
      this.bus.emit({ type: "protocol.error", message: error.message })
      this.emitState()

      if (this.protocolErrors > this.maxProtocolErrors) {
        this.fail(
          `The model failed to produce a valid tool call ${this.protocolErrors} times in a row. Last error: ${error.message}`,
        )
        return { kind: "stop" }
      }
      return { kind: "continue" }
    }

    this.fail(error instanceof Error ? error.message : String(error))
    return { kind: "stop" }
  }

  /** Clear the live stream buffer and return any reasoning it captured. */
  private takeStreamedReasoning(): string | undefined {
    const reasoning = this.streaming?.reasoning.trim()
    this.streaming = undefined
    return reasoning && reasoning.length > 0 ? reasoning : undefined
  }

  private allowedTools(): ToolName[] {
    if (this.mode === "waiting_for_user") return []
    if (this.mode === "push") return MODE_TOOLS.push
    if (this.stack.isEmpty) return ["push", "user"]
    const tools = [...MODE_TOOLS.execute]
    // No deeper delegation once the nesting limit is reached.
    return this.depth >= this.maxDepth ? tools.filter((tool) => tool !== "spawn") : tools
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /** Returns false when the loop must stop (user boundary or terminal state). */
  private async dispatch(action: ModelAction): Promise<boolean> {
    const violation = this.validateAction(action)
    if (violation) {
      this.protocolErrors += 1
      this.metrics.protocolErrors += 1
      this.observation = `PROTOCOL ERROR: ${violation}`
      this.addEntry("protocol", this.observation)
      this.bus.emit({ type: "protocol.error", message: violation })
      if (this.protocolErrors > this.maxProtocolErrors) {
        this.fail(`Repeated invalid actions. Last: ${violation}`)
      }
      return true
    }

    this.protocolErrors = 0
    this.metrics.toolCalls += 1

    this.activeTool = action.tool
    this.activeToolSince = Date.now()
    // Show the action the moment it starts, before it runs (instant feedback).
    if (action.tool !== "user") {
      this.addEntry("action", describeToolCall(action.tool, action.input), { tool: action.tool })
    }
    this.emitState()
    try {
      switch (action.tool) {
        case "bash":
          return await this.handleBash(action.input.command, action.input.timeoutMs)
        case "read":
          return this.handleRead(action.input.path)
        case "edit":
          return this.handleEdit(action.input.path, action.input.edits)
        case "push":
          return this.handlePush(action.input)
        case "spawn":
          return await this.handleSpawn(action.input)
        case "pop":
          return this.handlePop(action.input)
        case "user":
          return this.handleUser(action.input)
      }
    } finally {
      this.activeTool = undefined
      this.activeToolSince = undefined
      this.emitState()
    }
  }

  private validateAction(action: ModelAction): string | undefined {
    if (!MODE_TOOLS[this.mode].includes(action.tool)) {
      return `Tool "${action.tool}" is not available in ${this.mode} mode.`
    }
    if (action.tool === "pop" && this.stack.isEmpty) {
      return "Cannot pop: the task stack is empty."
    }
    if (action.tool === "push" && this.stack.depth >= this.maxStackDepth) {
      return `Cannot push: maximum stack depth (${this.maxStackDepth}) reached.`
    }
    const requiresFrame: ToolName[] = ["bash", "read", "edit", "pop", "spawn"]
    if (requiresFrame.includes(action.tool) && this.stack.isEmpty) {
      return `Tool "${action.tool}" requires an active task frame. Push one first, or report to the user.`
    }
    if (action.tool === "spawn" && this.depth >= this.maxDepth) {
      return `Subagent nesting limit (${this.maxDepth}) reached; handle this yourself.`
    }
    if (action.tool === "user" && !this.allowUser && action.input.response === "required") {
      return "A subagent cannot ask the user. Report with user(response:none) instead."
    }
    return undefined
  }

  private async handleBash(command: string, timeoutMs?: number): Promise<boolean> {
    this.bus.emit({ type: "tool.started", tool: "bash" })
    this.toolStream = ""
    const result = await runBash(command, {
      cwd: this.cwd,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      onOutput: (chunk) => {
        this.toolStream += chunk
        this.emitState()
      },
    })
    this.toolStream = ""
    this.bus.emit({ type: "tool.finished", tool: "bash", ok: result.ok })

    const value = result.value
    const output = (value?.output ?? "").replace(/\s+$/, "")
    const observation = result.ok
      ? output || "(no output)"
      : `command failed${value ? ` (exit ${value.exitCode})` : ""}: ${result.error ?? "unknown error"}${output ? `\n${output}` : ""}`

    this.observe(observation)
    return true
  }

  private handleRead(path: string): boolean {
    this.bus.emit({ type: "tool.started", tool: "read" })
    const result = runRead(path, { cwd: this.cwd })
    this.bus.emit({ type: "tool.finished", tool: "read", ok: result.ok })

    if (!result.ok || !result.value) {
      this.observe(`read ${path} FAILED: ${result.error ?? "unknown error"}`)
      return true
    }

    const { evicted, entry } = this.files.promote(path)
    this.metrics.filesPromoted += 1
    this.metrics.filesEvicted += evicted.length
    this.bus.emit({ type: "file.promoted", path: entry.path, tokens: entry.tokenCount })
    for (const path of evicted) this.bus.emit({ type: "file.evicted", path })

    const lines = result.value.content.split("\n").length
    const note = result.value.truncated ? " · truncated" : ""
    this.observe(
      `${path} · ${lines} lines · ~${entry.tokenCount} tokens${note} · now in the working set`,
    )
    return true
  }

  private handleEdit(path: string, edits: { oldText: string; newText: string; replaceAll?: boolean }[]): boolean {
    // Read-before-edit: only edit existing files that are in the working set, so
    // the model never patches contents it has not actually seen. Creating a new
    // file is still allowed (there is nothing to read).
    const exists = existsSync(resolvePath(this.cwd, path))
    if (exists && !this.files.has(path)) {
      this.bus.emit({ type: "tool.started", tool: "edit" })
      this.bus.emit({ type: "tool.finished", tool: "edit", ok: false })
      this.observe(
      `refused: ${path} is not in your working set. Call read("${path}") first, then retry the edit against the current contents.`,
      )
      return true
    }

    this.bus.emit({ type: "tool.started", tool: "edit" })
    const result = runEdit(path, edits, { cwd: this.cwd })
    this.bus.emit({ type: "tool.finished", tool: "edit", ok: result.ok })

    if (!result.ok || !result.value) {
      this.observe(`edit ${path} FAILED: ${result.error ?? "unknown error"}`)
      return true
    }

    const { evicted, entry } = this.files.promote(path)
    this.metrics.filesPromoted += 1
    this.metrics.filesEvicted += evicted.length
    this.bus.emit({ type: "file.promoted", path: entry.path, tokens: entry.tokenCount })
    for (const path of evicted) this.bus.emit({ type: "file.evicted", path })

    const verb = result.value.created ? "created" : "updated"
    this.observe(
      `${verb} ${path} · ${result.value.replacements} replacement${result.value.replacements === 1 ? "" : "s"} · ~${entry.tokenCount} tokens · now in the working set`,
    )
    return true
  }

  private async handleSpawn(action: PushAction): Promise<boolean> {
    const MAX_SUBAGENT_ENTRIES = 60
    let forwarded = 0
    const child = new AgentRuntime({
      cwd: this.cwd,
      llm: this.llm,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
      allowUser: false,
      maxStepsPerRun: this.maxStepsPerRun,
      maxStackDepth: this.maxStackDepth,
      maxProtocolErrors: this.maxProtocolErrors,
      fileBudgetTokens: this.files.budgetTokens,
      conversationBudgetTokens: this.files.budgetTokens,
    })

    // A subagent starts on the frame it was spawned for — the frame IS the
    // delegation boundary. It gets its own stack, file working set and history.
    const frame = child.stack.push(action)
    child.mode = "execute"
    this.bus.emit({ type: "subagent.started", depth: child.depth, frame })
    this.bus.emit({ type: "tool.started", tool: "spawn" })

    const stopForwarding = child.bus.on((event) => {
      if (event.type !== "conversation.added") return
      if (forwarded >= MAX_SUBAGENT_ENTRIES) return
      forwarded += 1
      const entry = event.entry
      this.addEntry("subagent", entry.text, {
        depth: child.depth,
        subrole: entry.role,
        ...(entry.tool ? { tool: entry.tool } : {}),
      })
    })

    let report: string
    let ok = true
    try {
      await child.run()
      report = child.lastReport ?? "(subagent finished without a report)"
    } catch (error) {
      ok = false
      report = `subagent failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      stopForwarding()
    }

    this.metrics.subagents += 1
    this.bus.emit({ type: "tool.finished", tool: "spawn", ok })
    this.bus.emit({ type: "subagent.finished", depth: child.depth, report })
    this.observe(`subagent report:\n${report}`)
    return true
  }

  private handlePush(action: PushAction): boolean {
    const frame = this.stack.push(action)
    this.mode = "execute"
    this.metrics.pushes += 1
    this.metrics.maxStackDepth = Math.max(this.metrics.maxStackDepth, this.stack.depth)
    this.bus.emit({ type: "frame.pushed", frame })
    this.observe(`top of stack · depth ${this.stack.depth}`)
    return true
  }

  private handlePop(action: PopAction): boolean {
    let closed: ClosedFrame
    try {
      closed = this.stack.pop(action)
    } catch (error) {
      this.observe(`pop FAILED: ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
    this.closedFrames.push(closed)
    this.metrics.pops += 1
    this.metrics.outcomes[closed.disposition.outcome] += 1
    this.bus.emit({ type: "frame.popped", frame: closed })
    this.observe(
      `closed · ${closed.disposition.outcome} · depth ${this.stack.depth}`,
    )
    return true
  }

  private handleUser(action: UserRequestAction): boolean {
    const record: UserRequestRecord = {
      ...action,
      choices: action.choices ?? undefined,
      id: randomUUID(),
      at: Date.now(),
      resolved: false,
    }
    this.userRequest = record
    this.metrics.userRequests += 1
    const message = formatUserMessage(record)
    this.addEntry("agent", message)
    this.bus.emit({ type: "user.request", request: record })

    if (action.response === "required") {
      this.mode = "waiting_for_user"
      this.bus.emit({ type: "state.changed" })
      return false
    }

    // optional / none: report and yield without waiting.
    this.report = message
    this.userRequest = undefined
    this.mode = this.stack.isEmpty ? "push" : "execute"
    this.bus.emit({ type: "state.changed" })
    return false
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Record a tool observation (the action entry was already added at tool start). */
  private observe(observation: string): void {
    this.addEntry("observation", observation)
    this.observation = observation
    this.emitState()
  }

  private fail(message: string): void {
    this.bus.emit({ type: "fatal", message })
    this.addEntry("protocol", `FATAL: ${message}`)
    this.observation = `FATAL: ${message}`
    this.userRequest = {
      id: randomUUID(),
      at: Date.now(),
      message: `The agent stopped due to an error:\n\n${message}`,
      response: "none",
      resolved: true,
    }
    this.mode = this.stack.isEmpty ? "push" : "execute"
    this.emitState()
  }

  private emitState(): void {
    this.bus.emit({ type: "state.changed" })
  }
}

export function formatUserMessage(request: UserRequestRecord): string {
  const lines = [request.message]
  if (request.choices && request.choices.length > 0) {
    lines.push("")
    request.choices.forEach((choice, index) => {
      const recommended = request.preferredChoice?.id === choice.id ? " [recommended]" : ""
      lines.push(`${index + 1}. ${choice.label}${recommended}`)
      if (choice.description) lines.push(`   ${choice.description}`)
    })
    if (request.preferredChoice) {
      lines.push("", `Recommended: ${request.preferredChoice.id} — ${request.preferredChoice.reason}`)
    }
  }
  return lines.join("\n")
}

export type { RuntimeEvent }
