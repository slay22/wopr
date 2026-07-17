import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { formatEvalForValidator, runEvaluation } from "../src/evaluate"

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "wopr-eval-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("runEvaluation", () => {
  test("disabled config never runs", async () => {
    const result = await runEvaluation(dir, { enabled: false, test: "exit 1" })
    expect(result).toEqual({ ran: false, passed: true, steps: [] })
  })

  test("runs steps in order and passes when all succeed", async () => {
    const result = await runEvaluation(dir, { install: "true", test: "true" })
    expect(result.passed).toBe(true)
    expect(result.steps.map((step) => step.step)).toEqual(["install", "test"])
  })

  test("stops at the first failure and skips the rest", async () => {
    const result = await runEvaluation(dir, { build: "false", test: "echo should-not-run" })
    expect(result.passed).toBe(false)
    const build = result.steps.find((step) => step.step === "build")!
    const testStep = result.steps.find((step) => step.step === "test")!
    expect(build.ok).toBe(false)
    expect(testStep.skipped).toBe(true)
  })

  test("captures command output", async () => {
    const result = await runEvaluation(dir, { test: "echo hello-from-eval" })
    expect(result.steps[0]!.output).toContain("hello-from-eval")
  })
})

describe("formatEvalForValidator", () => {
  test("is empty when nothing ran", () => {
    expect(formatEvalForValidator({ ran: false, passed: true, steps: [] })).toBe("")
  })

  test("headlines PASSED/FAILED and lists steps", () => {
    const text = formatEvalForValidator({ ran: true, passed: false, steps: [{ step: "test", command: "false", ok: false, exitCode: 1, output: "boom" }] })
    expect(text).toContain("FAILED")
    expect(text).toContain("- test: FAILED")
  })
})
