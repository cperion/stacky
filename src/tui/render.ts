import {
  bold,
  dim,
  isStyledText,
  StyledText,
  stringToStyledText,
  type BoxRenderable,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"

/** A styled part: either a full StyledText document or a single styled chunk. */
export type Part = StyledText | TextChunk

/** Width accepted by OpenTUI layout options. */
export type Dimension = number | `${number}%`

export function plain(text: string): StyledText {
  return stringToStyledText(text)
}

export function concat(parts: Part[]): StyledText {
  const chunks: TextChunk[] = []
  for (const part of parts) {
    if (isStyledText(part)) chunks.push(...part.chunks)
    else chunks.push(part)
  }
  return new StyledText(chunks)
}

/** A full-width dim horizontal rule. */
export function rule(width: number): StyledText {
  return concat([dim("─".repeat(Math.max(1, width)))])
}

/** A rule for a pane sized to the usable content width (no overflow, no wrap). */
export function paneRule(innerWidth: number): StyledText {
  return rule(innerWidth)
}

/** A dim horizontal rule with an embedded section label. */
export function sectionRule(label: string, width: number): StyledText {
  if (!label) return rule(width)
  const head = `── ${label} `
  return concat([dim(head + "─".repeat(Math.max(0, width - head.length)))])
}

/** Reliable inner width for a pane sized as a fraction of the terminal. */
export function fractionWidth(renderer: CliRenderer, frac: number, padding = 4): number {
  return Math.max(16, Math.floor(renderer.terminalWidth * frac) - padding)
}

/** A bold left label with a dim right-aligned value, filling `width`. */
export function header(left: string, right: string, width: number): StyledText {
  const gap = Math.max(1, width - left.length - right.length)
  return concat([bold(left), plain(" ".repeat(gap)), dim(right)])
}

/** Like `header`, but the right side is a pre-styled part of known length. */
export function headerWith(left: string, right: Part, rightLength: number, width: number): StyledText {
  const gap = Math.max(1, width - left.length - rightLength)
  return concat([bold(left), plain(" ".repeat(gap)), right])
}

/** Hard-wrap text to a visible width (word-aware, breaking over-long tokens). */
export function wrapRaw(text: string, width: number): string[] {
  const avail = Math.max(4, width)
  const out: string[] = []
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= avail) {
      out.push(rawLine)
      continue
    }
    let line = ""
    for (const word of rawLine.split(" ")) {
      if (word.length > avail) {
        if (line) {
          out.push(line)
          line = ""
        }
        let rest = word
        while (rest.length > avail) {
          out.push(rest.slice(0, avail))
          rest = rest.slice(avail)
        }
        line = rest
        continue
      }
      if (line.length === 0) line = word
      else if (line.length + 1 + word.length <= avail) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Wrap a block of text and prefix every line with an indent and optional gutter,
 * so wrapped continuations stay aligned with the first line.
 */
export function block(text: string, width: number, indent = 0, marker?: string): string {
  const prefix = " ".repeat(indent) + (marker ? `${marker} ` : "")
  const avail = width - prefix.length
  return wrapRaw(text, avail)
    .map((line) => prefix + line)
    .join("\n")
}

/** Right-align a value inside `width`. */
export function rightAlign(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value
}

/** Pad with spaces (or truncate) to exactly `width` columns. */
export function fit(text: string, width: number): string {
  if (width <= 0) return text
  if (text.length >= width) return text.slice(0, width)
  return text + " ".repeat(width - text.length)
}

/**
 * Inner content width of a laid-out pane: actual box width when known, else the
 * fraction fallback. Subtracts border (2), horizontal padding (2) and a column
 * for the scrollbar.
 */
export function paneInner(box: BoxRenderable, renderer: CliRenderer, frac: number, pad = 5): number {
  const width = box.width || Math.floor(renderer.terminalWidth * frac)
  return Math.max(12, width - pad)
}

/** Pad every line to exactly `width` columns (so a background spans the row). */
export function padLines(text: string, width: number): string {
  const limit = Math.max(1, width)
  return text
    .split("\n")
    .map((line) => (line.length >= limit ? line.slice(0, limit) : line + " ".repeat(limit - line.length)))
    .join("\n")
}

/** Clamp text to a maximum number of lines, appending a marker when truncated. */
export function clampLines(text: string, maxLines: number): string {
  const split = text.split("\n")
  if (split.length <= maxLines) return text
  const kept = split.slice(0, maxLines).join("\n")
  return `${kept}\n… (${split.length - maxLines} more lines)`
}

/** Prefix every line with a dim gutter, used to group tool output and thinking. */
export function gutter(text: string, marker = "│"): string {
  return text
    .split("\n")
    .map((line) => `${marker} ${line}`)
    .join("\n")
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

export function progressBar(ratio: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}
