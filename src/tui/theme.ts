import { RGBA, type CliRenderer, type ThemeMode } from "@opentui/core"

/** How the user wants the interface to be themed. */
export type ThemeModeSetting = "auto" | "dark" | "light"

export type Theme = {
  /** Base surface: the terminal's own default background (transparent). */
  bg: RGBA
  /** Base foreground: the terminal's own default foreground. */
  fg: RGBA
  /**
   * The ONE tint used only for user messages and tool output. Derived from the
   * terminal's reported background so it stays subtle on any colour scheme.
   */
  shade: RGBA
  red: RGBA
  green: RGBA
  yellow: RGBA
  blue: RGBA
  magenta: RGBA
  cyan: RGBA
  dim: RGBA
  gray: RGBA
  /** Chip bar + text pairs, guaranteed to contrast. */
  chip: {
    red: ChipColor
    green: ChipColor
    yellow: ChipColor
    blue: ChipColor
    magenta: ChipColor
    cyan: ChipColor
  }
}

/** A chip's bar colour and the text colour that contrasts with it. */
export type ChipColor = { bar: RGBA; text: RGBA }

const DARK_FALLBACK_BG = "#1a1b26"
const LIGHT_FALLBACK_BG = "#ffffff"

function accents(): Pick<Theme, "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "dim" | "gray"> {
  // ANSI palette indices stay themeable in both modes.
  return {
    red: RGBA.fromIndex(1),
    green: RGBA.fromIndex(2),
    yellow: RGBA.fromIndex(3),
    blue: RGBA.fromIndex(4),
    magenta: RGBA.fromIndex(5),
    cyan: RGBA.fromIndex(6),
    dim: RGBA.fromIndex(8),
    gray: RGBA.fromIndex(8),
  }
}

/** Relative luminance (0 dark .. 1 light) of an ANSI palette colour. */
function luminance(color: RGBA): number {
  const [r, g, b] = color.toInts()
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** Black or bright white, whichever gives a higher WCAG contrast with the bar. */
function contrastText(bar: RGBA): RGBA {
  const l = luminance(bar)
  const withWhite = 1.05 / (l + 0.05)
  const withBlack = (l + 0.05) / 0.05
  return RGBA.fromIndex(withBlack >= withWhite ? 0 : 15)
}

/**
 * Chip bar + text pairs. On a dark theme use the *bright* ANSI ramp, on a light
 * theme the *normal* (darker) ramp, so the bar always stands off the theme
 * background. The text colour is then chosen per bar from its luminance, so the
 * label is always legible.
 */
function chipColors(light: boolean): Pick<Theme, "chip"> {
  const ramp = light ? [1, 2, 3, 4, 5, 6] : [9, 10, 11, 12, 13, 14]
  const pair = (index: number): ChipColor => {
    const bar = RGBA.fromIndex(index)
    return { bar, text: contrastText(bar) }
  }
  return {
    chip: {
      red: pair(ramp[0]!),
      green: pair(ramp[1]!),
      yellow: pair(ramp[2]!),
      blue: pair(ramp[3]!),
      magenta: pair(ramp[4]!),
      cyan: pair(ramp[5]!),
    },
  }
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** Lift (dark) or drop (light) the terminal background to make a subtle tint. */
function deriveShade(light: boolean, backgroundHex: string | null): RGBA {
  const base = backgroundHex
    ? RGBA.fromHex(backgroundHex)
    : RGBA.fromHex(light ? LIGHT_FALLBACK_BG : DARK_FALLBACK_BG)
  const [r, g, b] = base.toInts()
  const delta = light ? -16 : 22
  return RGBA.fromInts(clamp255(r + delta), clamp255(g + delta), clamp255(b + delta))
}

/**
 * The interface itself stays terminal-native (`bg`/`fg` are the terminal's own
 * defaults); only `shade` is a concrete colour, and it is used solely for the
 * user-message and tool-output blocks.
 */
export function buildTheme(light: boolean, backgroundHex: string | null = null): Theme {
  return {
    bg: RGBA.defaultBackground(),
    fg: RGBA.defaultForeground(),
    shade: deriveShade(light, backgroundHex),
    ...accents(),
    ...chipColors(light),
  }
}

/** Mutable module-level theme; importers see the live value. */
export let theme: Theme = buildTheme(false)

/**
 * Resolve dark/light (from the setting or the terminal) and read the terminal's
 * real background so the user/tool tint is derived from the user's colour scheme
 * instead of a fixed grey.
 */
export async function applyTheme(renderer: CliRenderer, setting: ThemeModeSetting): Promise<ThemeMode> {
  let light: boolean
  if (setting === "light") {
    light = true
  } else if (setting === "dark") {
    light = false
  } else {
    let mode = renderer.themeMode
    if (!mode) {
      try {
        mode = await renderer.waitForThemeMode(150)
      } catch {
        mode = null
      }
    }
    light = mode === "light"
  }

  let backgroundHex: string | null = null
  try {
    const palette = await renderer.getPalette({ timeout: 200 })
    backgroundHex = palette.defaultBackground ?? null
  } catch {
    // Terminal did not answer the palette query — fall back to defaults.
  }

  theme = buildTheme(light, backgroundHex)
  return light ? "light" : "dark"
}

/** Terminal-native scrollbar colours, resolved lazily so they track the theme. */
export function scrollbarOptions() {
  return {
    trackOptions: { foregroundColor: theme.gray, backgroundColor: theme.bg },
    arrowOptions: { foregroundColor: theme.fg, backgroundColor: theme.bg },
  }
}
