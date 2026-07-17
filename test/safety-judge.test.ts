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
})
