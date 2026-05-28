import { describe, expect, test } from "bun:test"

import { UserAbortError, parseModel, shouldRetryAttempt, shouldSkip } from "../src/runner"

describe("runner helpers", () => {
  test("parses provider/model values", () => {
    expect(parseModel("anthropic/claude-sonnet-4-6")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    })
    expect(parseModel("custom/provider/model")).toEqual({ providerID: "custom", modelID: "provider/model" })
    expect(() => parseModel("claude-sonnet-4-6")).toThrow("invalid model")
  })

  test("applies only and skip phase filters", () => {
    expect(shouldSkip("security", { onlyPhases: ["implementer"], skipPhases: [] })).toBe(true)
    expect(shouldSkip("implementer", { onlyPhases: ["implementer"], skipPhases: ["implementer"] })).toBe(false)
    expect(shouldSkip("design", { onlyPhases: [], skipPhases: ["design"] })).toBe(true)
    expect(shouldSkip("tests", { onlyPhases: [], skipPhases: [] })).toBe(false)
  })

  test("does not retry after user abort", () => {
    const controller = new AbortController()
    expect(shouldRetryAttempt(new Error("temporary"), controller.signal, 1, 2)).toBe(true)

    controller.abort(new UserAbortError())
    expect(shouldRetryAttempt(new Error("aborted fetch"), controller.signal, 1, 2)).toBe(false)
    expect(shouldRetryAttempt(new UserAbortError(), new AbortController().signal, 1, 2)).toBe(false)
    expect(shouldRetryAttempt(new Error("exhausted"), new AbortController().signal, 2, 2)).toBe(false)
  })
})
