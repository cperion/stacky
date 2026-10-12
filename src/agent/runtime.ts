import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { EditAction, ReadAction, ModelAction, PopAction, PushAction, ToolName, TodoAction, UserRequestAction } from "../stack/schemas.ts"
import type {
  AgentMode,
  AgentState,
  ClosedFrame,
  Metrics,
  SessionSnapshot,
  StreamingState,
  UserRequestRecord,
} from "./types.ts"
import { reserveFrameSequences, TaskStack } from "../stack/stack.ts"
import { ACTION_SCHEMAS } from "../stack/schemas.ts"
import { ConversationBuffer } from "./conversation.ts"
import { MemoryStore } from "../memory/store.ts"
import { WorkspaceMemory, type MemoryResult } from "../memory/views.ts"
import { FrameHistory } from "../memory/history.ts"
import { EventBus, type RuntimeEvent } from "./events.ts"
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts"
import { ProtocolError, type LLMClient, type ModelInput, type StreamHandlers } from "../llm/client.ts"
import { createMetrics } from "./metrics.ts"
import { describeToolCall } from "./format-action.ts"
import { runBash } from "../tools/bash.ts"

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
  /** Override durable archive directory; child agents share a store, never views. */
  memoryDirectory?: string
  memoryStore?: MemoryStore
}

const MODE_TOOLS: Record<AgentMode, ToolName[]> = {
  // Planning is separate from execution: establish a frame before inspecting or changing anything.
  push: ["push", "user"],
  execute: ["bash", "read", "edit", "push", "pop", "todo", "spawn", "user"],
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
  private files: WorkspaceMemory
  private store: MemoryStore
  private history: FrameHistory
  private agentId: string = randomUUID()
  private ownsStore: boolean
  private workingContext = ""
  private closedFrames: ClosedFrame[] = []

  private mode: AgentMode = "push"
  private userRequest?: UserRequestRecord
  private observation = ""
  private running = false
  private activeTool?: string
  private activeCallRef?: string
  private activeToolSince?: number
  private toolStream = ""
  private pendingToolOk = true
  private lastTool?: { tool: string; ok: boolean; at: number }
  private protocolErrors = 0
  private streaming?: StreamingState
  private abortController?: AbortController
  private interrupted = false
  private activeChild?: AgentRuntime

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
    this.ownsStore = !opts.memoryStore
    this.store = opts.memoryStore ?? new MemoryStore(opts.memoryDirectory ?? join(
      process.env.STACKY_HISTORY ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "stacky", "history"),
      randomUUID(),
    ))
    this.history = new FrameHistory(this.store, this.agentId)
    this.files = new WorkspaceMemory({ cwd: opts.cwd, store: this.store, budgetTokens: opts.fileBudgetTokens ?? 24_000,
      resolveDocument: (ref, find) => this.history.resolve(ref, find) })
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
    const frameId = this.stack.top?.id
    const at = Date.now()
    // Archive before FIFO eviction; child transcripts and private reasoning are not duplicated here.
    const eventRef = role === "thinking" || role === "subagent" ? undefined
      : this.history.event("conversation", { role, text, at, ...meta }, frameId)
    const entry = this.conversation.add(role, text, { ...meta, frameId, eventRef }, at)
    this.bus.emit({ type: "conversation.added", entry })
  }

  /**
   * Request a stop at the next tool boundary and abort the active model/command.
   * Child runtimes receive the same interruption request.
   */
  interrupt(): boolean {
    if (!this.running) return false
    this.interrupted = true
    this.abortController?.abort()
    this.activeChild?.interrupt()
    return true
  }

  async stop(): Promise<void> {
    this.interrupt()
    if (!this.running) return
    await new Promise<void>((resolve) => {
      const off = this.bus.on(() => { if (!this.running) { off(); resolve() } })
    })
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
    if (evicted.length) {
      const ref = this.history.event("memory.evicted", { evicted, cause: "budget change" }, this.stack.top?.id)
      this.observation = `Working-context budget changed. Evicted: ${evicted.join("; ").slice(0, 1500)}\nDetails: read({ref:"${ref}"})`
    }
    this.emitState()
    return evicted
  }

  /** Clear active state and transcript; retain the archive, model and metrics. */
  reset(): void {
    if (this.running) throw new Error("Cannot reset while the agent is running.")
    const resetRef = this.history.event("session.reset", { activeFrames: this.stack.list().map((frame) => frame.id) })
    for (const frame of [...this.stack.list()].reverse()) {
      this.history.close({ intent: { ...frame, todos: frame.todos.map((todo) => todo.status === "pending" ? { ...todo, status: "abandoned", note: "Explicit user reset" } : todo) },
        disposition: { outcome: "abandoned", whatWasDone: "Active responsibility cancelled by the user; no completion is asserted.", whyClosed: "Explicit user reset", evidence: `Reset event ${resetRef}`, effectsOnParent: "Active state was cleared by the user.", closedAt: Date.now() } })
    }
    this.stack.clear()
    this.conversation.clear()
    this.files.clear()
    this.closedFrames = []
    this.userRequest = undefined
    this.observation = ""
    this.streaming = undefined
    this.protocolErrors = 0
    this.mode = "push"
    this.workingContext = ""
    this.emitState()
  }

  /** Last rendered context, without refreshing/authorizing code behind an in-flight model call. */
  inspectContext(): string { return this.workingContext || "(working context empty; read a resource to load a view)" }

  inspectHistory(ref = this.history.rootRef): string {
    const document = this.history.resolve(ref)
    if (document) return document.text
    const value = this.store.get(ref)
    return value.kind === "text" ? `Artifact ${ref}; use read({ref:"${ref}"}) in the agent to inspect it.` : JSON.stringify(value, null, 2)
  }

  dispose(): void { if (this.ownsStore) this.store.close() }

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
      ...(this.lastTool ? { lastTool: this.lastTool } : {}),
      conversation: [...this.conversation.entries()],
      stack: [...this.stack.list()],
      closedFrames: [...this.closedFrames],
      files: this.files.list(),
      memory: { historyRef: this.history.rootRef, directory: this.store.directory, ...this.files.summary() },
      userRequest: this.userRequest,
      metrics: { ...this.metrics, outcomes: { ...this.metrics.outcomes } },
      ...(this.streaming ? { streaming: { ...this.streaming } } : {}),
    }
  }

  /** Checkpoint view selections; historical bodies are held in the separate archive. */
  exportSession(): SessionSnapshot {
    return structuredClone({
      mode: this.mode,
      conversation: this.conversation.entries().filter((entry) => entry.role !== "thinking" && entry.role !== "subagent"),
      stack: [...this.stack.list()],
      closedFrames: [...this.closedFrames],
      filePaths: this.files.list().map((entry) => entry.path),
      memory: { directory: this.store.directory, cwd: resolve(this.cwd), agentId: this.agentId, views: this.files.exportViews() },
      ...(this.userRequest ? { userRequest: this.userRequest } : {}),
      metrics: { ...this.metrics, outcomes: { ...this.metrics.outcomes } },
    })
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
    if (this.running) throw new Error("Cannot restore a running agent.")
    data = structuredClone(data)
    if (data.memory) {
      if (data.memory.cwd !== resolve(this.cwd)) throw new Error(`Session belongs to ${data.memory.cwd}; resume with that --cwd. References must not silently target another workspace.`)
      if (!existsSync(join(data.memory.directory, "memory.sqlite"))) throw new Error(`History archive is missing: ${data.memory.directory}. Restore it alongside the session; references cannot be fabricated.`)
      const store = new MemoryStore(data.memory.directory)
      if (this.ownsStore) this.store.close()
      this.store = store
      this.ownsStore = true
      this.agentId = data.memory.agentId
      this.history = new FrameHistory(store, this.agentId)
      this.files = new WorkspaceMemory({ cwd: this.cwd, store, budgetTokens: this.files.budgetTokens,
        resolveDocument: (ref, find) => this.history.resolve(ref, find) })
    }
    this.conversation.restore(data.conversation ?? [])
    this.stack.restore(data.stack ?? [])
    this.closedFrames = (data.closedFrames ?? []).slice(-64)
    reserveFrameSequences(this.closedFrames.map((closed) => closed.intent))
    if (data.memory) this.files.restoreViews(data.memory.views)
    else {
      // Legacy sessions can only import the history they actually retained.
      this.files.restorePaths(data.filePaths ?? [])
      for (const frame of data.closedFrames ?? []) { frame.intent.historyRef = this.history.open(frame.intent, frame.intent.parentId); this.history.close(frame) }
      for (const [index, frame] of (data.stack ?? []).entries()) {
        frame.parentId ??= data.stack[index - 1]?.id
        frame.historyRef = this.history.open(frame, frame.parentId)
      }
      for (const entry of data.conversation ?? []) if (entry.role !== "thinking" && entry.role !== "subagent") this.history.event("legacy.conversation", entry, entry.frameId)
      this.history.event("legacy.import", { note: "Older evicted turns were not archived and cannot be recovered." })
    }
    this.workingContext = ""
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
    this.interrupted = false
    this.emitState()
    try {
      let steps = 0
      while (steps < this.maxStepsPerRun) {
        if (this.interrupted) return
        if (this.mode === "waiting_for_user") break
        steps += 1

        const result = await this.invokeModel()
        if (this.interrupted) {
          if (result.kind === "action") this.history.event("tool.not_executed", { action: result.action, reason: "Interrupted before dispatch" }, this.stack.top?.id)
          return
        }
        if (result.kind === "stop") return
        if (result.kind === "continue") continue

        const shouldContinue = await this.dispatch(result.action)
        if (!shouldContinue) return
      }
      this.fail(`Step limit reached (${this.maxStepsPerRun}) without reaching a user boundary.`)
    } catch (error) {
      // A failed durable write must stop execution, not silently lose the archive.
      const message = `Runtime stopped: ${error instanceof Error ? error.message : String(error)}`
      this.conversation.add("protocol", message)
      this.bus.emit({ type: "fatal", message })
    } finally {
      this.running = false
      this.activeTool = undefined
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
    this.workingContext = this.files.materialize()
    const notices = this.files.takeNotices()
    if (notices.length) {
      const ref = this.history.event("memory.notices", { notices }, this.stack.top?.id)
      this.observation = `${this.observation.slice(0, 1200)}\nWorking-context notices: ${notices.join("; ").slice(0, 1000)}\nDetails: read({ref:"${ref}"})`
    }
    const input: ModelInput = {
      system: buildSystemPrompt(allowedTools),
      prompt: buildUserPrompt({
        mode: this.mode,
        depth: this.depth,
        conversation: this.conversation.entries(),
        stack: this.stack.list(),
        files: [],
        workingContext: this.workingContext,
        historyContext: this.history.context(this.stack.list()),
        fileBudgetTokens: this.files.budgetTokens,
        fileUsedTokens: this.files.totalTokens(),
        observation: this.observation,
        ...(this.userRequest ? { userRequest: this.userRequest } : {}),
      }),
      allowedTools,
      mode: this.mode,
    }

    this.history.event("model.context", { model: this.llm.label, mode: this.mode,
      frames: this.stack.list().map((frame) => frame.historyRef ?? frame.id), views: this.files.exportViews() }, this.stack.top?.id)
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
    const callRef = this.history.event("tool.call", action, this.stack.top?.id)
    const violation = this.validateAction(action)
    if (violation) {
      this.history.event("tool.rejected", { callRef, violation }, this.stack.top?.id)
      this.protocolErrors += 1
      this.metrics.protocolErrors += 1
      this.observation = `PROTOCOL ERROR: ${violation}`
      this.addEntry("protocol", this.observation)
      this.bus.emit({ type: "protocol.error", message: violation })
      if (this.protocolErrors > this.maxProtocolErrors) {
        this.fail(`Repeated invalid actions. Last: ${violation}`)
        return false
      }
      return true
    }

    this.protocolErrors = 0
    this.metrics.toolCalls += 1

    this.activeCallRef = callRef
    this.activeTool = action.tool
    this.activeToolSince = Date.now()
    // Show the action the moment it starts, before it runs (instant feedback).
    if (action.tool !== "user") {
      this.addEntry("action", describeToolCall(action.tool, action.input), { tool: action.tool, eventRef: callRef })
    }
    this.emitState()
    try {
      switch (action.tool) {
        case "bash":
          return await this.handleBash(action.input.command, action.input.timeoutMs)
        case "read":
          return this.handleRead(action.input)
        case "edit":
          return this.handleEdit(action.input)
        case "push":
          return this.handlePush(action.input)
        case "spawn":
          return await this.handleSpawn(action.input)
        case "pop":
          return this.handlePop(action.input)
        case "todo":
          return this.handleTodo(action.input)
        case "user":
          return this.handleUser(action.input)
      }
    } finally {
      if (action.tool !== "user") {
        this.lastTool = { tool: action.tool, ok: this.pendingToolOk, at: Date.now() }
      }
      this.pendingToolOk = true
      this.activeTool = undefined
      this.activeCallRef = undefined
      this.activeToolSince = undefined
      this.toolStream = ""
      this.emitState()
    }
    return true
  }

  private validateAction(action: ModelAction): string | undefined {
    if (!MODE_TOOLS[this.mode].includes(action.tool)) {
      return `Tool "${action.tool}" is not available in ${this.mode} mode.`
    }
    const parsed = ACTION_SCHEMAS[action.tool].safeParse(action.input)
    if (!parsed.success) return `Invalid ${action.tool} arguments: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    if (action.tool === "pop" && this.stack.isEmpty) {
      return "Cannot pop: the task stack is empty."
    }
    if (action.tool === "push" && this.stack.depth >= this.maxStackDepth) {
      return `Cannot push: maximum stack depth (${this.maxStackDepth}) reached.`
    }
    const requiresFrame: ToolName[] = ["bash", "read", "edit", "pop", "todo", "spawn"]
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
    this.abortController = new AbortController()
    const result = await runBash(command, {
      cwd: this.cwd,
      signal: this.abortController.signal,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      onOutput: (chunk) => {
        this.toolStream = (this.toolStream + chunk).slice(-4000)
        this.emitState()
      },
    })
    this.abortController = undefined
    this.toolStream = ""
    this.bus.emit({ type: "tool.finished", tool: "bash", ok: result.ok })

    const value = result.value
    const output = value?.output ?? ""
    const artifact = this.files.capture(output, { title: `bash call ${this.activeCallRef} · ${command.split("\n")[0]?.slice(0, 100)}`, callRef: this.activeCallRef, frameId: this.stack.top?.id,
      exitCode: value?.exitCode, upstreamTruncated: value?.truncated ?? false, upstreamOmittedBytes: value?.omittedBytes ?? 0 })
    this.history.event("bash.result", { command, ok: result.ok, exitCode: value?.exitCode, error: result.error,
      outputRef: artifact.ref, captureTruncated: value?.truncated ?? false, omittedBytes: value?.omittedBytes ?? 0 }, this.stack.top?.id)
    const status = result.ok ? "command finished" : "command failed"
    this.observe(`${status}${value ? ` (exit ${value.exitCode})` : ""}${result.error ? `: ${result.error}` : ""}\n${artifact.message}${value?.truncated ? "\nCAPTURE LIMITED: omitted output is unavailable, not another page." : ""}${this.evictionNotice(artifact)}`, result.ok)
    return true
  }

  private handleRead(input: ReadAction): boolean {
    this.bus.emit({ type: "tool.started", tool: "read" })
    const result = this.files.read(input)
    return this.finishMemoryTool("read", result)
  }

  private handleEdit(input: EditAction): boolean {
    this.bus.emit({ type: "tool.started", tool: "edit" })
    const result = input.path !== undefined
      ? this.files.edit({ path: input.path, edits: input.edits.filter((edit) => "oldText" in edit) })
      : this.files.edit({ edits: input.edits.filter((edit) => "text" in edit) })
    return this.finishMemoryTool("edit", result)
  }

  private finishMemoryTool(tool: "read" | "edit", result: MemoryResult): boolean {
    this.bus.emit({ type: "tool.finished", tool, ok: result.ok })
    this.history.event(`${tool}.result`, result, this.stack.top?.id)
    if (result.ok && result.ref) {
      const descriptor = this.store.get(result.ref)
      if (descriptor.kind === "file" && typeof descriptor.path === "string") {
        const entry = this.files.list().find((file) => file.path === descriptor.path)
        if (entry) {
          this.metrics.filesPromoted++
          this.bus.emit({ type: "file.promoted", path: entry.path, tokens: entry.tokenCount })
        }
      }
    }
    this.observe(`${tool}${result.ok ? "" : " FAILED"}: ${result.message}${this.evictionNotice(result)}`, result.ok)
    return true
  }

  private evictionNotice(result: MemoryResult): string {
    this.metrics.filesEvicted += result.evicted.length
    for (const path of result.evicted) this.bus.emit({ type: "file.evicted", path })
    return result.evicted.length ? `\nEvicted from working context (still archived): ${result.evicted.join("; ")}` : ""
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
      memoryStore: this.store,
      maxStepsPerRun: this.maxStepsPerRun,
      maxStackDepth: this.maxStackDepth,
      maxProtocolErrors: this.maxProtocolErrors,
      fileBudgetTokens: this.files.budgetTokens,
      conversationBudgetTokens: this.files.budgetTokens,
    })

    // A subagent starts on the frame it was spawned for — the frame IS the
    // delegation boundary. It gets its own stack, file working set and history.
    const frame = child.stack.push(action)
    const parentRef = this.stack.top ? this.history.ref(this.stack.top.id) : this.history.rootRef
    frame.historyRef = child.history.open(frame, undefined, { spawnedFrom: parentRef })
    this.history.event("subagent.spawn", { childFrameRef: frame.historyRef, parentRef }, this.stack.top?.id)
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
    this.activeChild = child
    try {
      await child.run()
      report = child.lastReport ?? "(subagent finished without a report)"
      ok = child.lastReport !== undefined && child.stack.isEmpty
    } catch (error) {
      ok = false
      report = `subagent failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      this.activeChild = undefined
      stopForwarding()
    }

    this.metrics.subagents += 1
    this.bus.emit({ type: "tool.finished", tool: "spawn", ok })
    this.bus.emit({ type: "subagent.finished", depth: child.depth, report })
    const artifact = this.files.capture(report, { title: `Subagent report · ${frame.title}`, callRef: this.activeCallRef, childFrameRef: frame.historyRef })
    this.history.event("subagent.return", { childFrameRef: frame.historyRef, reportRef: artifact.ref, ok }, this.stack.top?.id)
    this.observe(`subagent report${child.stack.isEmpty ? "" : ` (${child.stack.depth} unresolved frame(s); not completed)`}: ${artifact.message}\nInspect child frame: read({ref:"${frame.historyRef}"})${this.evictionNotice(artifact)}`, ok)
    return true
  }

  private handlePush(action: PushAction): boolean {
    const parent = this.stack.top
    const resume = parent ? parent.todos.find((todo) => todo.status === "pending")?.text ?? parent.title : undefined
    if (parent) this.history.event("frame.suspend", { next: resume, childIntent: action.title ?? action.why, lastEvent: this.observation }, parent.id)
    const frame = this.stack.push(action)
    frame.historyRef = this.history.open(frame, parent?.id, { resume })
    this.mode = "execute"
    this.metrics.pushes += 1
    this.metrics.maxStackDepth = Math.max(this.metrics.maxStackDepth, this.stack.depth)
    this.bus.emit({ type: "frame.pushed", frame })
    this.observe(`top of stack · depth ${this.stack.depth} · frame ${frame.historyRef}`)
    return true
  }

  /** Resolve one step of the current frame's todo list. */
  private handleTodo(action: TodoAction): boolean {
    const frame = this.stack.top
    if (!frame) {
      this.observe("todo FAILED: no active frame", false)
      return true
    }
    const todo = frame.todos[action.index - 1]
    if (!todo) {
      this.observe(`todo FAILED: #${action.index} does not exist (the frame has ${frame.todos.length} steps)`, false)
      return true
    }
    if (action.status === "abandoned" && !action.note) {
      this.observe(`todo FAILED: abandoning #${action.index} needs a note explaining why`, false)
      return true
    }
    this.stack.markTodo(action.index, action.status, action.note)
    this.history.update(frame)
    this.observe(`todo #${action.index} ${action.status} · ${todo.text}`)
    return true
  }

  private handlePop(action: PopAction): boolean {
    // A frame is a checklist: it cannot close until every step is resolved.
    const frame = this.stack.top
    if (frame) {
      const pending = frame.todos.filter((todo) => todo.status === "pending")
      if (pending.length > 0) {
        this.observe(
          `pop REFUSED: ${pending.length} step${pending.length === 1 ? "" : "s"} still pending — mark them done or abandoned with todo() first:\n${pending
            .map((todo) => `  · ${todo.text}`)
            .join("\n")}`,
          false,
        )
        return true
      }
    }

    let closed: ClosedFrame
    try {
      closed = this.stack.pop(action)
    } catch (error) {
      this.observe(`pop FAILED: ${error instanceof Error ? error.message : String(error)}`, false)
      return true
    }
    const closeRef = this.history.close(closed)
    this.closedFrames.push(closed)
    if (this.closedFrames.length > 64) this.closedFrames.shift() // full history lives in the archive
    this.metrics.pops += 1
    this.metrics.outcomes[closed.disposition.outcome] += 1
    this.bus.emit({ type: "frame.popped", frame: closed })
    const parent = this.stack.top
    const next = parent?.todos.find((todo) => todo.status === "pending")
    const resume = parent ? `\nResuming ${parent.title} (${this.history.ref(parent.id)})${next ? ` · next unresolved: ${next.text}` : ""}\nChild effects: ${closed.disposition.effectsOnParent || "(none recorded)"}` : ""
    if (parent) this.history.event("frame.resume", { childFrameRef: closed.intent.historyRef, closeRef, next: next?.text, effects: closed.disposition.effectsOnParent }, parent.id)
    this.observe(`closed · ${closed.disposition.outcome} · depth ${this.stack.depth} · evidence read({ref:"${closeRef}"})${resume}`)
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
  private observe(observation: string, ok = true): void {
    this.pendingToolOk = ok
    const resultRef = this.history.event("tool.result", { tool: this.activeTool, callRef: this.activeCallRef, ok, observation }, this.stack.top?.id)
    const receipt = observation.length > 2400 ? `${observation.slice(0, 2200)}\n[More: read({ref:"${resultRef}"})]` : observation
    this.addEntry("observation", receipt, { eventRef: resultRef })
    this.observation = receipt
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
