import { describe, expect, test } from "bun:test"

import { serializeError } from "../../src/mcp/errors"
import { ConfigError } from "../../src/config"
import { RunNotFoundError, ValidationError, AbortError } from "../../src/core/errors"
import { BudgetExceededError } from "../../src/runner"

describe("serializeError", () => {
  test("serializes ConfigError", () => {
    const err = new ConfigError("invalid config")
    const result = serializeError(err)
    expect(result.code).toBe(-32001)
    expect(result.message).toBe("config_error")
    expect(result.data).toEqual({ message: "invalid config" })
  })

  test("serializes RunNotFoundError", () => {
    const err = new RunNotFoundError("run-abc-123")
    const result = serializeError(err)
    expect(result.code).toBe(-32002)
    expect(result.message).toBe("run_not_found")
    expect(result.data).toEqual({ runId: "run-abc-123" })
  })

  test("serializes ValidationError", () => {
    const err = new ValidationError(["field 'model' is required"])
    const result = serializeError(err)
    expect(result.code).toBe(-32003)
    expect(result.message).toBe("validation_error")
    expect(result.data).toEqual({ errors: ["field 'model' is required"] })
  })

  test("serializes AbortError", () => {
    const err = new AbortError("user cancelled")
    const result = serializeError(err)
    expect(result.code).toBe(-32004)
    expect(result.message).toBe("aborted")
    expect(result.data).toEqual({ reason: "user cancelled" })
  })

  test("serializes BudgetExceededError", () => {
    const err = new BudgetExceededError("implementer", 0.5, 2.0)
    const result = serializeError(err)
    expect(result.code).toBe(-32005)
    expect(result.message).toBe("budget_exceeded")
    expect(result.data).toEqual({ phase: "implementer", spent: 0.5, budget: 2.0 })
  })

  test("serializes unknown error without leaking internals", () => {
    const err = new Error("something broke")
    const result = serializeError(err)
    expect(result.code).toBe(-32603)
    expect(result.message).toBe("internal_error")
    expect(result.data).toEqual({ message: "something broke" })
  })

  test("serializes non-Error thrown values gracefully", () => {
    const result = serializeError("just a string")
    expect(result.code).toBe(-32603)
    expect(result.message).toBe("internal_error")
    expect(result.data).toEqual({ message: "just a string" })
  })

  test("serializes null gracefully", () => {
    const result = serializeError(null)
    expect(result.code).toBe(-32603)
    expect(result.message).toBe("internal_error")
  })
})
