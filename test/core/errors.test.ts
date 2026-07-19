import { describe, expect, test } from "bun:test"

import {
  RunNotFoundError,
  ValidationError,
  AbortError,
  ConfigError,
  BudgetExceededError,
} from "../../src/core/errors"
import { ConfigError as RealConfigError } from "../../src/config"

describe("RunNotFoundError", () => {
  test("has correct name and message", () => {
    const error = new RunNotFoundError("run-abc-123")
    expect(error.name).toBe("RunNotFoundError")
    expect(error.message).toContain("run-abc-123")
    expect(error.message).toContain("not found")
  })

  test("preserves runId", () => {
    const error = new RunNotFoundError("run-xyz-789")
    expect(error.runId).toBe("run-xyz-789")
  })

  test("is an instance of Error", () => {
    const error = new RunNotFoundError("test")
    expect(error).toBeInstanceOf(Error)
  })

  test("properties are directly accessible (not hidden in closure)", () => {
    const error = new RunNotFoundError("json-test")
    expect(error.name).toBe("RunNotFoundError")
    expect(error.message).toContain("json-test")
    expect(error.runId).toBe("json-test")
  })

  test("toJSON returns the expected shape", () => {
    const error = new RunNotFoundError("run-to-json")
    const json = error.toJSON()
    expect(json).toEqual({
      name: "RunNotFoundError",
      message: error.message,
      runId: "run-to-json",
    })
  })
})

describe("ValidationError", () => {
  test("has correct name and message", () => {
    const error = new ValidationError(["field 'model' is required", "field 'pipeline' is unknown"])
    expect(error.name).toBe("ValidationError")
    expect(error.message).toContain("field 'model' is required")
    expect(error.message).toContain("field 'pipeline' is unknown")
  })

  test("preserves errors array", () => {
    const errors = ["error one", "error two", "error three"]
    const error = new ValidationError(errors)
    expect(error.errors).toEqual(errors)
    expect(error.errors.length).toBe(3)
  })

  test("is an instance of Error", () => {
    const error = new ValidationError(["test error"])
    expect(error).toBeInstanceOf(Error)
  })

  test("works with a single error", () => {
    const error = new ValidationError(["only one error"])
    expect(error.message).toContain("only one error")
    expect(error.errors).toEqual(["only one error"])
  })

  test("properties are directly accessible", () => {
    const error = new ValidationError(["err1", "err2"])
    expect(error.name).toBe("ValidationError")
    expect(error.errors).toEqual(["err1", "err2"])
  })

  test("toJSON returns the expected shape", () => {
    const error = new ValidationError(["err-a", "err-b"])
    const json = error.toJSON()
    expect(json).toEqual({
      name: "ValidationError",
      message: error.message,
      errors: ["err-a", "err-b"],
    })
  })
})

describe("AbortError", () => {
  test("has correct name and message", () => {
    const error = new AbortError("user cancelled")
    expect(error.name).toBe("AbortError")
    expect(error.message).toContain("user cancelled")
    expect(error.message).toContain("aborted")
  })

  test("is an instance of Error", () => {
    const error = new AbortError("test")
    expect(error).toBeInstanceOf(Error)
  })

  test("preserves the reason", () => {
    const error = new AbortError("some reason")
    expect(error.reason).toBe("some reason")
  })

  test("properties are directly accessible", () => {
    const error = new AbortError("some reason")
    expect(error.name).toBe("AbortError")
    expect(error.message).toContain("some reason")
    expect(error.reason).toBe("some reason")
  })

  test("toJSON returns the expected shape", () => {
    const error = new AbortError("test abort reason")
    const json = error.toJSON()
    expect(json).toEqual({
      name: "AbortError",
      message: error.message,
      reason: "test abort reason",
    })
  })
})

describe("ConfigError (re-exported)", () => {
  test("is the same class as the source ConfigError", () => {
    expect(ConfigError).toBe(RealConfigError)
  })

  test("is constructable", () => {
    const error = new ConfigError("invalid configuration")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("ConfigError")
    expect(error.message).toContain("invalid configuration")
  })

  test("toJSON returns the expected shape", () => {
    const error = new ConfigError("bad config")
    const json = error.toJSON()
    expect(json).toEqual({
      name: "ConfigError",
      message: "bad config",
    })
  })

  test("JSON.stringify outputs toJSON shape correctly", () => {
    const error = new ConfigError("serialize me")
    const parsed = JSON.parse(JSON.stringify(error))
    expect(parsed.name).toBe("ConfigError")
    expect(parsed.message).toContain("serialize me")
  })
})

describe("BudgetExceededError (re-exported)", () => {
  test("has correct name and properties", () => {
    const error = new BudgetExceededError("implementer", 0.5, 2.0)
    expect(error.name).toBe("BudgetExceededError")
    expect(error.message).toContain("0.50")
    expect(error.message).toContain("2.00")
    expect(error.phase).toBe("implementer")
    expect(error.spent).toBe(0.5)
    expect(error.budget).toBe(2.0)
  })

  test("is an instance of Error", () => {
    const error = new BudgetExceededError("test", 0, 1)
    expect(error).toBeInstanceOf(Error)
  })

  test("properties are directly accessible", () => {
    const error = new BudgetExceededError("security", 1.23, 5.00)
    expect(error.name).toBe("BudgetExceededError")
    expect(error.phase).toBe("security")
    expect(error.spent).toBe(1.23)
    expect(error.budget).toBe(5.00)
  })

  test("toJSON returns the expected shape", () => {
    const error = new BudgetExceededError("tests", 1.5, 3.0)
    const json = error.toJSON()
    expect(json).toEqual({
      name: "BudgetExceededError",
      message: error.message,
      phase: "tests",
      spent: 1.5,
      budget: 3.0,
    })
  })

  test("JSON.stringify encodes all fields via toJSON", () => {
    const error = new BudgetExceededError("implementer", 0.42, 5.00)
    const parsed = JSON.parse(JSON.stringify(error))
    expect(parsed.name).toBe("BudgetExceededError")
    expect(parsed.phase).toBe("implementer")
    expect(parsed.spent).toBe(0.42)
    expect(parsed.budget).toBe(5.0)
  })
})
