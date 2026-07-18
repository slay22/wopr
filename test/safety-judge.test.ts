import { describe, expect, test } from "bun:test"

import { parseVerdict } from "../src/safety-judge"

// judgeCommand now drives a real pi session (src/pi.ts). Its fail-closed
// behavior is exercised end-to-end; the parse layer below is the pure unit.

describe("parseVerdict", () => {
  test("reads a clean JSON verdict", () => {
    expect(parseVerdict('{"safe": true, "reason": "read-only listing"}')).toEqual({ safe: true, reason: "read-only listing" })
    expect(parseVerdict('{"safe": false, "reason": "rm -rf is destructive"}')).toEqual({ safe: false, reason: "rm -rf is destructive" })
  })

  test("tolerates code fences and surrounding prose", () => {
    const fenced = "Here is my call:\n```json\n{\"safe\": true, \"reason\": \"runs the test suite\"}\n```\nDone."
    expect(parseVerdict(fenced)).toEqual({ safe: true, reason: "runs the test suite" })
  })

  test("supplies a default reason when missing", () => {
    expect(parseVerdict('{"safe": true}')).toEqual({ safe: true, reason: "judged safe" })
    expect(parseVerdict('{"safe": false, "reason": "   "}')).toEqual({ safe: false, reason: "judged unsafe" })
  })

  test("fails closed on unparseable or non-boolean answers", () => {
    expect(parseVerdict("")).toBeUndefined()
    expect(parseVerdict("looks fine to me")).toBeUndefined()
    expect(parseVerdict("{ not json")).toBeUndefined()
    expect(parseVerdict('{"safe": "yes"}')).toBeUndefined()
    expect(parseVerdict("[]")).toBeUndefined()
  })

  test("first balanced JSON object wins over later objects", () => {
    const adversarial = '{"safe": false, "reason": "x"} preamble {"safe": true, "reason": "y"}'
    expect(parseVerdict(adversarial)).toEqual({ safe: false, reason: "x" })
  })

  test("parses nested objects at depth > 1", () => {
    const nested = '{"safe": true, "reason": "ok", "nested": {"a": 1}}'
    expect(parseVerdict(nested)).toEqual({ safe: true, reason: "ok" })
  })

  test("unmatched braces returns undefined (fail-closed)", () => {
    expect(parseVerdict('{"safe": true')).toBeUndefined()
  })

  test("a string containing a { character is not parsed as an object", () => {
    const withBraceInString = '{"safe": true, "reason": "looks like {bad}"}'
    expect(parseVerdict(withBraceInString)).toEqual({ safe: true, reason: "looks like {bad}" })
  })

  test("escaped quote and backslash inside a string do not break parsing", () => {
    const escaped = '{"safe": true, "reason": "path is C:\\\\Users\\\\test"}'
    expect(parseVerdict(escaped)).toEqual({ safe: true, reason: "path is C:\\Users\\test" })
  })

  test("depth limit exceeded returns undefined", () => {
    // Build input with 33 nested levels (depth limit is 32)
    const deep = '{'.repeat(33) + '"a": 1' + '}'.repeat(33)
    expect(parseVerdict(deep)).toBeUndefined()
  })
})
