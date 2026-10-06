import {
  bold,
  dim,
  fg,
  italic,
  strikethrough,
  stringToStyledText,
  underline,
  type ColorInput,
  type TextChunk,
} from "@opentui/core"
import { concat, plain, type Part } from "./render.ts"
import { theme } from "./theme.ts"

/** A styled run of text inside a markdown line. */
type Seg = {
  text: string
  fg?: ColorInput
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  dim?: boolean
}

const CODE = () => theme.cyan
const LINK = () => theme.blue
const HEADING = () => theme.blue

// Inline patterns (no nesting; `code`, **bold**, __bold__, *italic*, _italic_,
// ~~strike~~, [text](url)).
const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)/g

function inline(text: string): Seg[] {
  const segs: Seg[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) segs.push({ text: text.slice(last, index) })
    const [full, code, boldStar, boldUnderscore, italicStar, italicUnderscore, strike, linkText, linkUrl] = match
    if (code !== undefined) segs.push({ text: code, fg: CODE() })
    else if (boldStar !== undefined || boldUnderscore !== undefined) segs.push({ text: boldStar ?? boldUnderscore ?? "", bold: true })
    else if (italicStar !== undefined || italicUnderscore !== undefined) segs.push({ text: italicStar ?? italicUnderscore ?? "", italic: true })
    else if (strike !== undefined) segs.push({ text: strike, strike: true })
    else if (linkText !== undefined) {
      segs.push({ text: linkText, fg: LINK(), underline: true })
      if (linkUrl && linkUrl !== linkText) segs.push({ text: ` (${linkUrl})`, dim: true })
    }
    last = index + full.length
  }
  if (last < text.length) segs.push({ text: text.slice(last) })
  return segs.length > 0 ? segs : [{ text }]
}

function styleSeg(seg: Seg): Part {
  let node: string | TextChunk = seg.text
  if (seg.fg) node = fg(seg.fg)(node)
  if (seg.dim) node = dim(node)
  if (seg.bold) node = bold(node)
  if (seg.italic) node = italic(node)
  if (seg.underline) node = underline(node)
  if (seg.strike) node = strikethrough(node)
  return typeof node === "string" ? stringToStyledText(node) : node
}

/** Greedy wrap of styled runs to `width` visible columns. */
function wrapSegments(segments: Seg[], width: number): Seg[][] {
  const limit = Math.max(4, width)
  const words: Seg[] = []
  for (const seg of segments) {
    for (const piece of seg.text.split(/(\s+)/)) {
      if (piece.length > 0) words.push({ ...seg, text: piece })
    }
  }

  const lines: Seg[][] = []
  let line: Seg[] = []
  let length = 0
  const flush = () => {
    if (line.length > 0) lines.push(line)
    line = []
    length = 0
  }

  for (const word of words) {
    const isSpace = /^\s+$/.test(word.text)
    if (isSpace) {
      if (line.length === 0) continue
      if (length + word.text.length > limit) {
        flush()
        continue
      }
      line.push(word)
      length += word.text.length
      continue
    }
    if (length + word.text.length > limit && line.length > 0) flush()
    if (word.text.length > limit) {
      let rest = word.text
      while (rest.length > limit) {
        line.push({ ...word, text: rest.slice(0, limit) })
        rest = rest.slice(limit)
        flush()
      }
      if (rest.length > 0) {
        line.push({ ...word, text: rest })
        length = rest.length
      }
      continue
    }
    line.push(word)
    length += word.text.length
  }
  flush()
  return lines
}

function styleLine(line: Seg[]): Part {
  return concat(line.map(styleSeg))
}

/**
 * Render a markdown string into styled text. Consecutive lines become paragraphs;
 * fenced code, headings, lists, blockquotes and rules get simple terminal-native
 * styling. Inline `code`, **bold**, *italic*, ~~strike~~ and [links](url) are
 * supported.
 */
export function renderMarkdown(text: string, width: number, indent = 0): ReturnType<typeof concat> {
  const pad: Seg = { text: " ".repeat(Math.max(0, indent)) }
  const limit = Math.max(8, width - indent)
  const out: Part[] = []
  let first = true

  const pushLine = (segs: Seg[]) => {
    if (!first) out.push(plain("\n"))
    first = false
    if (segs.length > 0) out.push(styleLine(segs))
  }

  const pushWrapped = (segs: Seg[], prefix = "", continuation = prefix) => {
    const lines = wrapSegments(segs, limit - prefix.length)
    if (lines.length === 0) {
      pushLine([])
      return
    }
    lines.forEach((line, index) => {
      const marker = index === 0 ? prefix : continuation
      pushLine([pad, ...(marker ? [{ text: marker }] : []), ...line])
    })
  }

  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  let fence = false

  for (const raw of lines) {
    const fenceMatch = /^\s*```(.*)$/.exec(raw)
    if (fenceMatch) {
      fence = !fence
      continue
    }

    if (fence) {
      pushWrapped([{ text: raw, fg: CODE() }], "│ ")
      continue
    }

    if (raw.trim() === "") {
      pushLine([])
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      const level = heading[1]?.length ?? 1
      const seg: Seg = { text: heading[2] ?? "", bold: true, ...(level <= 2 ? { fg: HEADING() } : {}) }
      pushWrapped([seg])
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      pushLine([pad, { text: "─".repeat(limit), dim: true }])
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw)
    if (quote) {
      pushWrapped(inline(quote[1] ?? "").map((seg) => ({ ...seg, dim: true })), "│ ")
      continue
    }

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(raw)
    if (unordered) {
      pushWrapped(inline(unordered[1] ?? ""), "• ", "  ")
      continue
    }

    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(raw)
    if (ordered) {
      const marker = `${ordered[1]}. `
      pushWrapped(inline(ordered[2] ?? ""), marker, " ".repeat(marker.length))
      continue
    }

    pushWrapped(inline(raw))
  }

  // Trim leading/trailing blank lines.
  let end = out.length
  while (end > 0 && isBlank(out[end - 1]!)) end -= 1
  let start = 0
  while (start < end && isBlank(out[start]!)) start += 1

  return concat(out.slice(start, end))
}

function isBlank(part: Part): boolean {
  if ("chunks" in part) return part.chunks.every((chunk) => chunk.text.trim().length === 0)
  return part.text.trim().length === 0
}
