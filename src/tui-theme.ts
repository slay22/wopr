import { StyledText, bold, fg, stringToStyledText, t } from "@opentui/core"

import type { CliRenderer, TextChunk } from "@opentui/core"

// Backgrounds are never painted: the whole canvas is the terminal's own
// background, and panels are delineated by borders alone. The single
// exception is `overlay`, the opaque backdrop floating modals need to mask
// the content underneath them.
export type Palette = {
  bg: string
  overlay: string
  border: string
  borderDim: string
  accent: string
  teal: string
  green: string
  red: string
  yellow: string
  orange: string
  magenta: string
  cyan: string
  text: string
  dim: string
  faint: string
  /** Text drawn on top of colored chips (selected permission buttons). */
  chipText: string
}

export type PaletteColor = Exclude<keyof Palette, "chipText">

// WOPR identity: a NORAD "big board" phosphor terminal. Dark terminals get
// green-on-black CRT; light terminals fall back to amber (green-on-light is
// unreadable). Backgrounds stay unpainted — only the accents change.
const darkPalette: Palette = {
  bg: "transparent",
  overlay: "#03110A",
  border: "#1F3D2C",
  borderDim: "#15271C",
  accent: "#33FF77",
  teal: "#2BE0C4",
  green: "#4CFF88",
  red: "#FF5666",
  yellow: "#FFC24B",
  orange: "#FF9E3D",
  magenta: "#B99CF0",
  cyan: "#5EEAD4",
  text: "#CDEFD6",
  dim: "#5E8C6E",
  faint: "#37543F",
  chipText: "#03110A",
}

// Amber big-board fallback for light terminals.
const lightPalette: Palette = {
  bg: "transparent",
  overlay: "#F3ECDD",
  border: "#C9B486",
  borderDim: "#DDD1B4",
  accent: "#B45309",
  teal: "#0F766E",
  green: "#4D7C0F",
  red: "#C2262E",
  yellow: "#A16207",
  orange: "#C2410C",
  magenta: "#6D28D9",
  cyan: "#0E7490",
  text: "#3A2E12",
  dim: "#7A6A44",
  faint: "#A99A76",
  chipText: "#F3ECDD",
}

// When the terminal never answers the background query there is nothing safe
// to paint, so even modals stay transparent and mid-brightness colors keep
// the text readable on dark and light — a muted phosphor green that survives both.
const neutralPalette: Palette = {
  bg: "transparent",
  overlay: "transparent",
  border: "#4A7358",
  borderDim: "#3C5C48",
  accent: "#3FBF6E",
  teal: "#2BA893",
  green: "#5BB56A",
  red: "#D9545F",
  yellow: "#C79A3A",
  orange: "#CE8633",
  magenta: "#9C7EC8",
  cyan: "#3FA7B8",
  text: "#9FB8A6",
  dim: "#6E8A76",
  faint: "#556B5C",
  chipText: "#04160C",
}

// Module-level on purpose: one TUI exists per wopr process, and a mutable
// palette spares threading it through every render helper.
export let theme: Palette = darkPalette

export function setTheme(palette: Palette) {
  theme = palette
}

export function paletteForMode(mode: "dark" | "light" | null | undefined): Palette {
  if (mode === "light") return lightPalette
  if (mode === "dark") return darkPalette
  return neutralPalette
}

/**
 * Palette tuned to the terminal's own background: borders are subtle
 * elevations of it and modals repaint it exactly, so nothing reads as a
 * foreign skin. Accents still come from the static palettes (picked by the
 * background's brightness, which is the same inference opentui uses for the
 * mode). Without a reported background this falls back to paletteForMode.
 */
export function paletteForTerminal(mode: "dark" | "light" | null | undefined, backgroundHex?: string): Palette {
  const rgb = backgroundHex ? parseHex(backgroundHex) : undefined
  if (!rgb) return paletteForMode(mode)
  const isDark = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 <= 128
  const pole: Rgb = isDark ? [255, 255, 255] : [0, 0, 0]
  return {
    ...(isDark ? darkPalette : lightPalette),
    // The reported color, not transparent: a modal must mask what's beneath
    // it, and repainting the terminal's own background makes that invisible.
    overlay: backgroundHex!,
    borderDim: mixToward(rgb, pole, 0.16),
    border: mixToward(rgb, pole, 0.26),
    chipText: backgroundHex!,
  }
}

/**
 * The background the terminal reported via OSC 11, if any. Reaches into
 * opentui internals (RendererThemeMode keeps the raw color private to its
 * dark/light inference); the dependency is pinned, and any shape change just
 * degrades to the static palettes.
 */
export function terminalBackgroundHex(renderer: CliRenderer): string | undefined {
  const state = (renderer as unknown as { themeModeState?: { themeOscBackground?: unknown } }).themeModeState
  const hex = state?.themeOscBackground
  return typeof hex === "string" && parseHex(hex) ? hex : undefined
}

type Rgb = [number, number, number]

function parseHex(hex: string): Rgb | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return undefined
  const value = Number.parseInt(match[1]!, 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function mixToward(rgb: Rgb, pole: Rgb, amount: number): string {
  const hex = (index: number) =>
    Math.round(rgb[index]! + (pole[index]! - rgb[index]!) * amount)
      .toString(16)
      .padStart(2, "0")
  return `#${hex(0)}${hex(1)}${hex(2)}`
}

export type PhaseStatus = "pending" | "running" | "completed" | "skipped" | "failed"

// A rotating radar dish — the "big board" is scanning while a phase runs.
const spinnerFrames = ["◐", "◓", "◑", "◒"]

export function spinnerFrame(now: number) {
  return spinnerFrames[Math.floor(now / 100) % spinnerFrames.length]!
}

export function statusIcon(status: PhaseStatus, now: number): TextChunk {
  switch (status) {
    case "completed":
      return fg(theme.green)("✓")
    case "running":
      return fg(theme.accent)(spinnerFrame(now))
    case "failed":
      return fg(theme.red)("✗")
    case "skipped":
      return fg(theme.faint)("⊘")
    default:
      return fg(theme.faint)("○")
  }
}

export function joinLines(lines: StyledText[]): StyledText {
  const chunks: TextChunk[] = []
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(raw("\n"))
    chunks.push(...line.chunks)
  })
  return new StyledText(chunks)
}

export function plain(text: string): StyledText {
  return stringToStyledText(text)
}

export function raw(text: string): TextChunk {
  return stringToStyledText(text).chunks[0] ?? fg(theme.text)(text)
}

export function padBetween(left: TextChunk[], right: TextChunk[], width: number): StyledText {
  const gap = Math.max(1, width - chunksLength(left) - chunksLength(right))
  if (right.length === 0) return new StyledText(left)
  return new StyledText([...left, raw(" ".repeat(gap)), ...right])
}

function chunksLength(chunks: TextChunk[]) {
  return chunks.reduce((sum, chunk) => sum + displayWidth(chunk.text), 0)
}

// East-Asian wide chars and emoji take two terminal cells; counting UTF-16
// units would push the right-aligned columns out of the panel.
export function displayWidth(text: string) {
  return Bun.stringWidth(text)
}

// Block elements render single-width in every terminal font, and the
// full-cell blocks read as one solid strip instead of a thin stroke.
export function progressBar(fraction: number, width: number, color: string): TextChunk[] {
  const cells = Math.max(0, Math.min(1, fraction)) * width
  const filled = Math.floor(cells)
  const head = filled < width && cells - filled >= 0.5
  const track = width - filled - (head ? 1 : 0)
  const chunks: TextChunk[] = []
  if (filled > 0) chunks.push(fg(color)("█".repeat(filled)))
  if (head) chunks.push(fg(color)("▌"))
  if (track > 0) chunks.push(fg(theme.faint)("░".repeat(track)))
  return chunks
}

export function formatMoney(cost: number) {
  return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`
}

/**
 * Budget meter bar: renders spent/cap with a progress bar and color coding.
 * Green when spent < 60% of cap, yellow when < 90%, red when ≥ 90% or exceeded.
 * Returns an empty array when spent is undefined or cap is 0.
 */
export function budgetBar(spent: number | undefined, cap: number | undefined, width = 20): TextChunk[] {
  if (spent === undefined || cap === undefined || cap <= 0) return []
  const fraction = Math.min(1, spent / cap)
  const pct = Math.round(fraction * 100)

  const color =
    spent > cap || fraction >= 0.9
      ? theme.red
      : fraction >= 0.6
        ? theme.yellow
        : theme.green

  // Labeled metric, matching the rest of the UI: a dim "BUDGET" label with
  // the value and progress bar colored by the spend ratio (green < 60%,
  // yellow < 90%, red ≥ 90% or over cap). The bar color encodes the state;
  // the label stays quiet like the other readouts (CONVERGE, verdict, dir).
  const label = fg(theme.dim)("BUDGET ")
  const value = `${formatMoney(spent)}/${formatMoney(cap)} (${pct}%)`
  const barWidth = Math.max(4, width - displayWidth(label.text) - displayWidth(value) - 1)
  const bar = progressBar(fraction, barWidth, color)

  return [label, fg(color)(value), raw(" "), ...bar]
}

export function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatElapsed(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function formatAgo(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds <= 1) return "now"
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`
}

/** "2d 3h" / "2h 10m" / "12m" — countdown until a quota window resets. */
export function fmtCountdown(resetsAt: number, now: number) {
  const totalMinutes = Math.max(0, Math.floor((resetsAt - now) / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatTime(time: number) {
  return new Date(time).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function shortID(value: string) {
  if (value.length <= 12) return value
  return `${value.slice(0, 7)}…${value.slice(-4)}`
}

export function shortUrl(value: string) {
  return value.replace(/^https?:\/\//, "")
}

export function projectName(dir: string) {
  if (!dir) return "…"
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

/** Full path with the home prefix as ~, truncated from the left so the deepest segments stay readable. */
export function shortPath(dir: string, max: number) {
  if (!dir) return "…"
  const home = process.env.HOME
  const path = home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
  if (path.length <= max) return path
  return `…${path.slice(-Math.max(1, max - 1))}`
}

export function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (displayWidth(singleLine) <= max) return singleLine
  if (max <= 0) return ""
  if (max === 1) return "…"
  return `${takeDisplayCells(singleLine, max - 1).head}…`
}

// Markdown stays unrendered on purpose; headings get the accent so long
// summaries are scannable without pulling in a parser.
export function styleSummaryLine(line: string): StyledText {
  if (/^#{1,6}\s/.test(line)) return t`${bold(fg(theme.accent)(line))}`
  if (/^(```|---+$)/.test(line.trim())) return t`${fg(theme.faint)(line)}`
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) return new StyledText([fg(theme.teal)(line.match(/^\s*/)![0] + "• "), raw(line.replace(/^\s*([-*+]|\d+\.)\s/, ""))])
  return plain(line)
}

export function wrapLines(lines: string[], width: number): string[] {
  const wrapped: string[] = []
  for (const line of lines) {
    if (width <= 0) {
      wrapped.push("")
      continue
    }
    if (displayWidth(line) <= width) {
      wrapped.push(line)
      continue
    }
    let rest = line
    while (rest && displayWidth(rest) > width) {
      const part = takeDisplayCells(rest, width)
      // Widths used by the TUI are always >= 2. This fallback prevents an
      // infinite loop if a caller asks a one-cell column to hold a wide glyph.
      if (!part.head) {
        const first = [...graphemes.segment(rest)][0]?.segment ?? ""
        wrapped.push(first)
        rest = rest.slice(first.length)
      } else {
        wrapped.push(part.head)
        rest = part.tail
      }
    }
    if (rest) wrapped.push(rest)
  }
  return wrapped
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function takeDisplayCells(text: string, max: number): { head: string; tail: string } {
  let head = ""
  let cells = 0
  let consumed = 0
  for (const part of graphemes.segment(text)) {
    const width = displayWidth(part.segment)
    if (cells + width > max) break
    head += part.segment
    cells += width
    consumed = part.index + part.segment.length
  }
  return { head, tail: text.slice(consumed) }
}
