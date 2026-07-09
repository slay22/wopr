import { describe, expect, test } from "bun:test"

import type { CliRenderer } from "@opentui/core"
import { displayWidth, paletteForMode, paletteForTerminal, terminalBackgroundHex, truncate, wrapLines } from "../src/tui-theme"

// terminalBackgroundHex reaches into opentui internals; the adapter must read a
// real reply but degrade to undefined (→ static palettes) on any shape change.
const fakeRenderer = (themeModeState: unknown) => ({ themeModeState }) as unknown as CliRenderer

describe("palette derivation from the terminal background", () => {
  test("measures wide and combined graphemes in terminal cells", () => {
    expect(displayWidth("ascii")).toBe(5)
    expect(displayWidth("界🙂é")).toBe(5)
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2)
    expect(truncate("界界界", 5)).toBe("界界…")
    expect(wrapLines(["界界a"], 3)).toEqual(["界", "界a"])
    expect(wrapLines(["éé"], 1)).toEqual(["é", "é"])
  })

  test("dark background: transparent canvas, borders lifted toward white, overlay repaints the terminal", () => {
    const palette = paletteForTerminal("dark", "#1a1b26")

    expect(palette.bg).toBe("transparent")
    expect(palette.overlay).toBe("#1a1b26")
    expect(palette.chipText).toBe("#1a1b26")
    // 16% / 26% toward white from #1a1b26.
    expect(palette.borderDim).toBe("#3f3f49")
    expect(palette.border).toBe("#56565e")
    // Accents come from the static dark palette.
    expect(palette.accent).toBe(paletteForMode("dark").accent)
  })

  test("light background: borders sink toward black with light accents", () => {
    const palette = paletteForTerminal("light", "#fafafa")

    expect(palette.bg).toBe("transparent")
    expect(palette.overlay).toBe("#fafafa")
    expect(palette.borderDim).toBe("#d2d2d2")
    expect(palette.border).toBe("#b9b9b9")
    expect(palette.accent).toBe(paletteForMode("light").accent)
  })

  // The mode needs both OSC replies inside opentui's 250ms window, but a lone
  // background reply is enough to derive the palette ourselves.
  test("brightness of the background wins over an unresolved mode", () => {
    expect(paletteForTerminal(null, "#000000").accent).toBe(paletteForMode("dark").accent)
    expect(paletteForTerminal(null, "#ffffff").accent).toBe(paletteForMode("light").accent)
  })

  test("falls back to the static palettes without a usable background", () => {
    expect(paletteForTerminal("dark", undefined)).toBe(paletteForMode("dark"))
    expect(paletteForTerminal(null, "not-a-color")).toBe(paletteForMode(null))
  })

  test("reads a real OSC background reply but fails safe on a changed internal shape", () => {
    // A usable reply is read straight through.
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: "#1a1b26" }))).toBe("#1a1b26")

    // Anything that isn't a parseable hex string degrades to undefined.
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: "not-a-color" }))).toBeUndefined()
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: 0x1a1b26 }))).toBeUndefined()

    // A dependency upgrade that drops or renames the internal state must not throw.
    expect(terminalBackgroundHex(fakeRenderer(undefined))).toBeUndefined()
    expect(terminalBackgroundHex(fakeRenderer({}))).toBeUndefined()
    expect(terminalBackgroundHex({} as unknown as CliRenderer)).toBeUndefined()
  })

  test("no palette ever paints a panel background", () => {
    for (const palette of [
      paletteForMode("dark"),
      paletteForMode("light"),
      paletteForMode(null),
      paletteForTerminal("dark", "#1a1b26"),
      paletteForTerminal("light", "#fafafa"),
    ]) {
      expect(palette.bg).toBe("transparent")
    }
  })
})
