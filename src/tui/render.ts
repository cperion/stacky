import { isStyledText, StyledText, stringToStyledText, type TextChunk } from "@opentui/core"

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

/** Clamp text to a maximum number of lines, appending a marker when truncated. */
export function clampLines(text: string, maxLines: number): string {
  const split = text.split("\n")
  if (split.length <= maxLines) return text
  const kept = split.slice(0, maxLines).join("\n")
  return `${kept}\n… (${split.length - maxLines} more lines)`
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

export function progressBar(ratio: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}
