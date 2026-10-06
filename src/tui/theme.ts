import { RGBA, type CliRenderer, type ThemeMode } from "@opentui/core"

/** How the user wants the interface to be themed. */
export type ThemeModeSetting = "auto" | "dark" | "light"

export type Theme = {
  /** Base surface: the terminal background (or white in light mode). */
  bg: RGBA
  /** Default foreground (or black in light mode). */
  fg: RGBA
  /** ONE shared tint for user input and tool output, derived from `bg`. */
  shade: RGBA
  red: RGBA
  green: RGBA
  yellow: RGBA
  blue: RGBA
  magenta: RGBA
  cyan: RGBA
  dim: RGBA
  gray: RGBA
}

const DARK_FALLBACK_BG = "#1a1b26"
const DARK_FALLBACK_FG = "#e6e6e6"
const LIGHT_BG = "#ffffff"
const LIGHT_FG = "#000000"

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

/** Shift a colour a little towards the foreground's direction for a subtle tint. */
function deriveShade(background: RGBA, light: boolean): RGBA {
  const [r, g, b] = background.toInts()
  const delta = light ? -14 : 22
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value + delta)))
  return RGBA.fromInts(clamp(r), clamp(g), clamp(b))
}

export function buildTheme(mode: ThemeMode, background?: string | null, foreground?: string | null): Theme {
  const light = mode === "light"
  const bg = light
    ? RGBA.fromHex(LIGHT_BG)
    : background
      ? RGBA.fromHex(background)
      : RGBA.fromHex(DARK_FALLBACK_BG)
  const fg = light
    ? RGBA.fromHex(LIGHT_FG)
    : foreground
      ? RGBA.fromHex(foreground)
      : RGBA.fromHex(DARK_FALLBACK_FG)
  return { ...accents(), bg, fg, shade: deriveShade(bg, light) }
}

/** Mutable module-level theme; importers see the live value. */
export let theme: Theme = buildTheme("dark")

/**
 * Resolve the mode: an explicit setting, or whatever the terminal reports.
 * Then (for dark mode) read the terminal's real background so the shared shade
 * is derived from the user's own colour scheme instead of a fixed grey.
 */
export async function applyTheme(renderer: CliRenderer, setting: ThemeModeSetting): Promise<ThemeMode> {
  let mode: ThemeMode
  if (setting === "dark" || setting === "light") {
    mode = setting
  } else if (renderer.themeMode) {
    mode = renderer.themeMode
  } else {
    try {
      mode = (await renderer.waitForThemeMode(150)) ?? "dark"
    } catch {
      mode = "dark"
    }
  }

  let background: string | null = null
  let foreground: string | null = null
  if (mode === "dark") {
    try {
      const palette = await renderer.getPalette({ timeout: 200 })
      background = palette.defaultBackground ?? null
      foreground = palette.defaultForeground ?? null
    } catch {
      // Terminal did not answer the palette query — fall back to defaults.
    }
  }

  theme = buildTheme(mode, background, foreground)
  return mode
}

/** Terminal-native scrollbar colours, resolved lazily so they track the theme. */
export function scrollbarOptions() {
  return {
    trackOptions: { foregroundColor: theme.gray, backgroundColor: theme.bg },
    arrowOptions: { foregroundColor: theme.fg, backgroundColor: theme.bg },
  }
}
