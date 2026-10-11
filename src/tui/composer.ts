import { BoxRenderable, TextareaRenderable, TextRenderable, bold, dim, fg, reverse, type CliRenderer } from "@opentui/core"
import { PROVIDERS } from "../llm/catalog.ts"
import { cachedModels, listModels, type ModelSource } from "../llm/models.ts"
import { hasApiKey, type ProviderName } from "../llm/providers.ts"
import { applyCompletion, completionSet, PromptHistory, type Candidate, type CompletionSet } from "./complete.ts"
import { concat, clipText, fit, plain, type Part } from "./render.ts"
import { theme } from "./theme.ts"

// A structural type also makes keyboard behavior straightforward to test.
type Key = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; preventDefault(): void; stopPropagation(): void }
export type ComposerOptions = {
  provider: () => ProviderName
  onSubmit: (text: string) => void
  canSubmit?: (text: string) => boolean
  onHeightChange?: () => void
}

/** One prompt implementation for both interfaces. The popup never enters history. */
export class Composer {
  readonly box: BoxRenderable
  readonly input: TextareaRenderable
  private popup: TextRenderable
  private prompt: BoxRenderable
  private history = new PromptHistory()
  private matches: CompletionSet | undefined
  private selected = -1
  private dismissed = false
  private disposed = false
  private loading = false
  private feedback = ""
  private fetchedAt = 0
  private sources = new Map<ProviderName, ModelSource>()
  private popupRows = 0
  private promptRows = 3
  private reportedHeight = 3
  private paletteDraft: { text: string; cursor: number } | undefined

  constructor(private renderer: CliRenderer, private opts: ComposerOptions) {
    this.box = new BoxRenderable(renderer, { width: "100%", height: 3, flexShrink: 0, flexDirection: "column" })
    this.popup = new TextRenderable(renderer, { content: "", fg: theme.fg, bg: theme.bg, wrapMode: "none", height: 0 })
    this.prompt = new BoxRenderable(renderer, { width: "100%", height: 3, flexDirection: "row" })
    this.prompt.add(new TextRenderable(renderer, { content: concat([fg(theme.green)("❯ ")]), width: 2, height: 1 }))
    this.input = new TextareaRenderable(renderer, {
      placeholder: "Ask anything · / commands",
      height: 3,
      flexGrow: 1,
      minWidth: 0,
      wrapMode: "word",
      backgroundColor: theme.bg,
      focusedBackgroundColor: theme.bg,
      textColor: theme.fg,
      focusedTextColor: theme.fg,
      placeholderColor: theme.gray,
      cursorColor: theme.green,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "linefeed", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "return", meta: true, action: "newline" },
      ],
    })
    this.input.onSubmit = () => {
      if (this.selected >= 0) { this.accept(); return }
      const text = this.input.plainText
      if (this.opts.canSubmit && !this.opts.canSubmit(text)) {
        this.feedback = "Draft kept · wait for the turn to finish, or Esc to stop"
        this.paint()
        return
      }
      this.history.add(text)
      if (this.paletteDraft) this.restoreDraft()
      else this.setText("")
      this.opts.onSubmit(text)
    }
    this.input.onCursorChange = () => { this.selected = -1; this.refresh() }
    this.input.onContentChange = () => {
      this.feedback = ""
      this.selected = -1
      this.dismissed = false
      this.refresh()
      if (/^\/models?\s/.test(this.input.plainText)) void this.fetchModels()
    }
    this.prompt.add(this.input)
    this.box.add(this.popup)
    this.box.add(this.prompt)
  }

  get height(): number { return this.promptRows + this.popupRows }

  dispose(): void { this.disposed = true }

  openCommands(): void {
    if (this.paletteDraft) { this.restoreDraft(); return }
    this.paletteDraft = { text: this.input.plainText, cursor: this.input.cursorOffset }
    this.input.setText("/")
    this.input.cursorOffset = 1
    this.dismissed = false
    this.refresh()
  }

  private restoreDraft(): void {
    const draft = this.paletteDraft
    this.paletteDraft = undefined
    if (draft) { this.setText(draft.text); this.input.cursorOffset = draft.cursor }
  }

  setText(text: string): void {
    this.input.setText(text)
    this.input.cursorOffset = text.length
    this.selected = -1
    this.dismissed = true
    this.refresh()
  }

  /** Consume only prompt-specific keys. Choices and menus still own their motions. */
  handleKey(key: Key): boolean {
    const consume = () => { key.preventDefault(); key.stopPropagation(); return true }
    if (key.name === "escape" && this.paletteDraft) {
      this.restoreDraft()
      return consume()
    }
    if (key.name === "escape" && this.popupRows > 0) {
      this.dismissed = true
      this.selected = -1
      this.refresh()
      return consume()
    }
    if (key.name === "tab") {
      this.dismissed = false
      this.refresh()
      const count = this.matches?.candidates.length ?? 0
      if (count === 1) { this.selected = 0; this.accept() }
      else if (count > 1) {
        this.selected = this.selected < 0 ? (key.shift ? count - 1 : 0) : (this.selected + (key.shift ? -1 : 1) + count) % count
        this.paint()
      }
      return consume()
    }
    if (this.selected >= 0 && (key.name === "up" || key.name === "down")) {
      const count = this.matches!.candidates.length
      this.selected = (this.selected + (key.name === "up" ? -1 : 1) + count) % count
      this.paint()
      return consume()
    }
    // Alt+Up/Down browse history from anywhere. Bare arrows only at buffer edges.
    const text = this.input.plainText
    const edge = key.name === "up" ? this.input.cursorOffset === 0 : this.input.cursorOffset === text.length
    if ((key.name === "up" || key.name === "down") && (key.meta || ((this.history.isBrowsing(text) || edge) && !text.includes("\n")))) {
      const previous = this.history.move(key.name === "up" ? -1 : 1, text)
      if (previous !== undefined) {
        this.setText(previous)
        if (key.name === "up") this.input.cursorOffset = 0
        return consume()
      }
    }
    return false
  }

  refresh(): void {
    if (this.disposed || this.renderer.isDestroyed) return
    const selectedValue = this.matches?.candidates[this.selected]?.value
    this.matches = this.dismissed ? undefined : completionSet(this.input.plainText, this.input.cursorOffset, this.modelCandidates())
    this.selected = selectedValue ? this.matches?.candidates.findIndex((item) => item.value === selectedValue) ?? -1 : -1
    this.paint()
  }

  private accept(): void {
    const candidate = this.matches?.candidates[this.selected]
    if (!candidate || !this.matches) return
    const result = applyCompletion(this.input.plainText, this.matches, candidate)
    this.input.setText(result.text)
    this.input.cursorOffset = result.cursor
    this.selected = -1
    this.dismissed = true
    this.refresh()
  }

  private modelCandidates(): Candidate[] {
    // Avoid disk/auth reads on every ordinary keystroke.
    if (!/^\/models?\s/.test(this.input.plainText)) return []
    return PROVIDERS.flatMap((provider) => {
      const available = hasApiKey(provider)
      const source = this.sources.get(provider)
      const description = !available
        ? (provider === "chatgpt" ? "sign in: /login chatgpt" : "API key required")
        : source === "api" ? "provider list" : source === "cache" ? "cached list" : "unverified list"
      return cachedModels(provider).map((id) => ({
        value: `${provider}/${id}`,
        description: `${description}${provider === this.opts.provider() ? " · current provider" : ""}`,
      }))
    })
  }

  private async fetchModels(): Promise<void> {
    if (this.loading || Date.now() - this.fetchedAt < 60_000) return
    this.loading = true
    this.fetchedAt = Date.now()
    this.paint()
    try {
      await Promise.all(PROVIDERS.filter(hasApiKey).map(async (provider) => {
        const result = await listModels(provider)
        this.sources.set(provider, result.source)
      }))
    } finally {
      this.loading = false
      if (!this.disposed) this.refresh()
    }
  }

  private paint(): void {
    if (this.disposed || this.renderer.isDestroyed) return
    const width = Math.max(8, (this.box.width || this.renderer.width) - 1)
    const candidates = this.matches?.candidates ?? []
    const limit = Math.max(1, Math.min(5, Math.floor(this.renderer.terminalHeight / 4)))
    const start = Math.max(0, this.selected - limit + 1)
    const visible = candidates.slice(start, start + limit)
    const parts: Part[] = []
    visible.forEach((item, row) => {
      const selected = start + row === this.selected
      const label = `${selected ? "❯" : " "} ${item.value}`
      const hint = width > 60 ? `  ${item.description}` : ""
      const text = fit(clipText(label + hint, width), width)
      if (row > 0) parts.push(plain("\n"))
      parts.push(selected ? reverse(bold(text)) : plain(text))
    })
    const empty = !this.dismissed && /^\/(?:models?\s+\S*|[\w-]*)$/.test(this.input.plainText)
    if (visible.length) {
      parts.push(plain("\n"), dim(clipText(`${this.selected >= 0 ? `${this.selected + 1}/` : ""}${candidates.length} matches · Tab/⇧Tab ${this.selected >= 0 ? "cycle · Enter accept" : "choose · Enter send"} · Esc close${this.loading ? " · fetching…" : ""}`, width)))
    } else if (empty || this.feedback) {
      parts.push(dim(clipText(this.feedback || (this.loading ? "Fetching model lists…" : "No matches · /help for commands · /model refresh to update"), width)))
    }
    this.popup.content = concat(parts)
    this.popupRows = visible.length ? visible.length + 1 : (empty || this.feedback) ? 1 : 0
    this.promptRows = this.renderer.terminalHeight < 12 ? 1 : 3
    this.popup.height = this.popupRows
    this.prompt.height = this.promptRows
    this.input.height = this.promptRows
    this.box.height = this.height
    if (this.reportedHeight !== this.height) {
      this.reportedHeight = this.height
      this.opts.onHeightChange?.()
    }
  }
}
