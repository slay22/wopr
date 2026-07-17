import { describe, expect, test } from "bun:test"

import { autoFollowGroup, comparisonColumnCount, computeDefcon, initialContentTab, iteratePrompt, pipelineSelectionTargets } from "../src/tui"

import type { LoopProgress, ProgressPhase } from "../src/progress"

describe("run dashboard defaults", () => {
  test("starts live runs on session and historical runs on reports, never logs", () => {
    const live = initialContentTab("live")
    const historical = initialContentTab("historical")

    expect(live).toBe("session")
    expect(historical).toBe("reports")
    expect([live, historical]).not.toContain("logs")
  })
})

describe("iterate prompt", () => {
  test("names the run, lists every context file, and stays on one line", () => {
    const files = ["/runs/x/prd.md", "/runs/x/reports/plan.md", "/runs/x/reports/implement.md"]
    const prompt = iteratePrompt("20260713-101010-abcd", files)

    expect(prompt).toContain("20260713-101010-abcd")
    for (const file of files) expect(prompt).toContain(file)
    // The command travels through `zsh -lc`; a newline would break quoting assumptions.
    expect(prompt).not.toContain("\n")
    // The agent must know to wait instead of acting on the reports alone.
    expect(prompt.toLowerCase()).toContain("wait")
  })
})

describe("computeDefcon", () => {
  const phase = (status: string, attempt = 0) => ({ status: status as never, attempt })
  const loop = (over: Partial<LoopProgress>): LoopProgress => ({ loopId: "loop1", iteration: 1, maxIterations: 3, status: "running", ...over })

  test("calm run is DEFCON 5, a failed run is DEFCON 1", () => {
    expect(computeDefcon([phase("running", 1), phase("completed", 1)], undefined, false)).toBe(5)
    expect(computeDefcon([phase("completed")], undefined, true)).toBe(1)
  })

  test("retries and a failed-but-not-final phase escalate", () => {
    expect(computeDefcon([phase("running", 2)], undefined, false)).toBe(3)
    expect(computeDefcon([phase("running", 3)], undefined, false)).toBe(2)
    expect(computeDefcon([phase("failed", 1)], undefined, false)).toBe(2)
  })

  test("loop verdict/status raise the alert", () => {
    expect(computeDefcon([], loop({ verdict: "PARTIAL" }), false)).toBe(4)
    expect(computeDefcon([], loop({ status: "replanning", verdict: "REJECT" }), false)).toBe(3)
    expect(computeDefcon([], loop({ status: "stalled" }), false)).toBe(2)
    // run-failed still trumps everything.
    expect(computeDefcon([], loop({ status: "converged", verdict: "PASS" }), true)).toBe(1)
  })
})

describe("pipeline group selection", () => {
  test("includes model and parallel headers in the same order as their child rows", () => {
    const phases: ProgressPhase[] = [
      { name: "prepare", description: "" },
      { name: "review__opus", description: "", groupId: "models", stepName: "review", plannedModel: "anthropic/claude-opus" },
      { name: "review__gpt", description: "", groupId: "models", stepName: "review", plannedModel: "openai/gpt" },
      { name: "lint", description: "", groupId: "parallel", stepName: "lint" },
      { name: "test__fast", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/fast" },
      { name: "test__deep", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/deep" },
      { name: "finish", description: "" },
    ]

    expect(pipelineSelectionTargets(phases)).toEqual([
      { kind: "phase", name: "prepare" },
      { kind: "group", groupId: "models", stepName: "review" },
      { kind: "phase", name: "review__opus" },
      { kind: "phase", name: "review__gpt" },
      { kind: "group", groupId: "parallel" },
      { kind: "phase", name: "lint" },
      { kind: "group", groupId: "parallel", stepName: "test" },
      { kind: "phase", name: "test__fast" },
      { kind: "phase", name: "test__deep" },
      { kind: "phase", name: "finish" },
    ])
  })

  test("auto-follow rests on the group header while any member of a concurrent group is active", () => {
    const phases: ProgressPhase[] = [
      { name: "prepare", description: "", groupId: "g1" },
      { name: "review__opus", description: "", groupId: "models", stepName: "review", plannedModel: "anthropic/claude-opus" },
      { name: "review__gpt", description: "", groupId: "models", stepName: "review", plannedModel: "openai/gpt" },
      { name: "lint", description: "", groupId: "parallel", stepName: "lint" },
      { name: "test__fast", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/fast" },
      { name: "test__deep", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/deep" },
      { name: "finish", description: "" },
    ]

    // Sequential steps (unique or missing groupId) follow the leaf itself.
    expect(autoFollowGroup(phases, phases[0]!)).toBeUndefined()
    expect(autoFollowGroup(phases, phases[6]!)).toBeUndefined()

    // A pure models: fan-out follows its step header, whichever member emits.
    expect(autoFollowGroup(phases, phases[1]!)).toEqual({ kind: "group", groupId: "models", stepName: "review" })
    expect(autoFollowGroup(phases, phases[2]!)).toEqual({ kind: "group", groupId: "models", stepName: "review" })

    // A parallel block of distinct steps follows its top header — the same
    // stable node no matter which child (plain or fanned-out) was active last.
    expect(autoFollowGroup(phases, phases[3]!)).toEqual({ kind: "group", groupId: "parallel" })
    expect(autoFollowGroup(phases, phases[4]!)).toEqual({ kind: "group", groupId: "parallel" })
    expect(autoFollowGroup(phases, phases[5]!)).toEqual({ kind: "group", groupId: "parallel" })
  })

  test("uses readable adaptive comparison columns", () => {
    expect(comparisonColumnCount(40, 3)).toBe(1)
    expect(comparisonColumnCount(70, 3)).toBe(2)
    expect(comparisonColumnCount(100, 3)).toBe(3)
    expect(comparisonColumnCount(200, 5)).toBe(3)
  })
})
