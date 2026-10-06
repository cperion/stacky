import { RGBA } from "@opentui/core"

/**
 * Terminal-native palette.
 *
 * Nothing here is a fixed RGB colour:
 *  - `fg` / `bg` are the terminal's default foreground and background, emitted
 *    as SGR 39 / 49, so the user's own theme shows through untouched.
 *  - accents are ANSI palette *indices* (SGR 38;5;N), which the terminal maps to
 *    whatever colours the user has configured.
 *  - emphasis is expressed with the `bold` / `dim` text attributes, not colour.
 *
 * No background colour is ever painted, and every renderable must be given an
 * explicit `fg` / `borderColor` / `titleColor`, because OpenTUI's built-in
 * default is truecolor white — which would be invisible on a light terminal.
 */
export const theme = {
  fg: RGBA.defaultForeground(),
  bg: RGBA.defaultBackground(),

  // ANSI palette indices (0-7 normal, 8-15 bright).
  red: RGBA.fromIndex(1),
  green: RGBA.fromIndex(2),
  yellow: RGBA.fromIndex(3),
  blue: RGBA.fromIndex(4),
  magenta: RGBA.fromIndex(5),
  cyan: RGBA.fromIndex(6),
  /** Bright black: AA muted tone for structure (borders, rules, secondary text). */
  dim: RGBA.fromIndex(8),
  gray: RGBA.fromIndex(8),
} as const

/** Terminal-native scrollbar colours, shared by every pane. */
export const scrollbarTheme = {
  trackOptions: { foregroundColor: theme.gray, backgroundColor: theme.bg },
  arrowOptions: { foregroundColor: theme.fg, backgroundColor: theme.bg },
} as const
