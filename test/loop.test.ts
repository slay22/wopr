import { describe, expect, test } from "bun:test"

import { isStalled, planSignature, verdictImproved } from "../src/loop"

import type { Plan } from "../src/plan-schema"

const task = (id: string, file: string, action: Plan["tasks"][number]["action"] = "modify") => ({
  id,
  file,
  action,
  instruction: "x",
  rationale: "",
  priority: "P1" as const,
  source: ["systems"],
})

const plan = (tasks: Plan["tasks"]): Plan => ({ summary: "s", tasks, riskFlags: [], outOfScope: [] })

describe("planSignature", () => {
  test("is order-independent over the task set", () => {
    const a = plan([task("t1", "a.ts"), task("t2", "b.ts")])
    const b = plan([task("t2", "b.ts"), task("t1", "a.ts")])
    expect(planSignature(a)).toBe(planSignature(b))
  })

  test("changes when a task's file or action changes", () => {
    const a = plan([task("t1", "a.ts", "modify")])
    const b = plan([task("t1", "a.ts", "delete")])
    expect(planSignature(a)).not.toBe(planSignature(b))
  })
})

describe("verdictImproved", () => {
  test("ranks REJECT < PARTIAL < PASS", () => {
    expect(verdictImproved(undefined, "REJECT")).toBe(true)
    expect(verdictImproved("REJECT", "PARTIAL")).toBe(true)
    expect(verdictImproved("PARTIAL", "PASS")).toBe(true)
    expect(verdictImproved("PARTIAL", "REJECT")).toBe(false)
    expect(verdictImproved("PASS", "PASS")).toBe(false)
  })
})

describe("isStalled", () => {
  const sig = "same"
  test("stalls only when the plan is unchanged and the verdict did not improve", () => {
    expect(isStalled({ prevPlanSig: sig, currPlanSig: sig, prevVerdict: "REJECT", currVerdict: "REJECT" })).toBe(true)
    // Plan changed → not stalled.
    expect(isStalled({ prevPlanSig: "old", currPlanSig: sig, prevVerdict: "REJECT", currVerdict: "REJECT" })).toBe(false)
    // Verdict improved → not stalled.
    expect(isStalled({ prevPlanSig: sig, currPlanSig: sig, prevVerdict: "REJECT", currVerdict: "PARTIAL" })).toBe(false)
    // First iteration (no prior plan) → never stalled.
    expect(isStalled({ prevPlanSig: undefined, currPlanSig: sig, prevVerdict: undefined, currVerdict: "REJECT" })).toBe(false)
  })
})
