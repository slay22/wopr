import { describe, expect, test } from "bun:test"

import { extractJson, parsePlan, parseValidatorReport } from "../src/plan-schema"

const goodPlan = {
  summary: "Add a sum function",
  tasks: [
    { id: "t1", file: "src/sum.ts", action: "create", instruction: "add sum(a,b)", rationale: "requested", priority: "P0", source: ["systems"] },
  ],
  riskFlags: [],
  outOfScope: ["docs"],
}

describe("extractJson", () => {
  test("reads a fenced ```json block", () => {
    expect(extractJson('prose\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 })
  })

  test("reads the last balanced object when unfenced, ignoring trailing prose", () => {
    expect(extractJson('here it is {"a":1} and done.')).toEqual({ a: 1 })
  })

  test("is not fooled by braces inside strings", () => {
    expect(extractJson('{"msg":"a } b { c"}')).toEqual({ msg: "a } b { c" })
  })

  test("throws when there is no JSON object", () => {
    expect(() => extractJson("just prose, no object")).toThrow(/no parseable JSON/)
  })
})

describe("parsePlan", () => {
  test("accepts a well-formed plan", () => {
    const plan = parsePlan(`\`\`\`json\n${JSON.stringify(goodPlan)}\n\`\`\``)
    expect(plan.tasks[0]).toMatchObject({ id: "t1", action: "create", priority: "P0", source: ["systems"] })
    expect(plan.outOfScope).toEqual(["docs"])
  })

  test("rejects an empty task list", () => {
    expect(() => parsePlan(JSON.stringify({ ...goodPlan, tasks: [] }))).toThrow(/at least one task/)
  })

  test("rejects a bad action / priority", () => {
    expect(() => parsePlan(JSON.stringify({ ...goodPlan, tasks: [{ ...goodPlan.tasks[0], action: "frobnicate" }] }))).toThrow(/action/)
    expect(() => parsePlan(JSON.stringify({ ...goodPlan, tasks: [{ ...goodPlan.tasks[0], priority: "P9" }] }))).toThrow(/priority/)
  })

  test("requires a source citing at least one reviewer", () => {
    expect(() => parsePlan(JSON.stringify({ ...goodPlan, tasks: [{ ...goodPlan.tasks[0], source: [] }] }))).toThrow(/source/)
  })
})

describe("parseValidatorReport", () => {
  test("parses a verdict with per-task results", () => {
    const report = parseValidatorReport(
      JSON.stringify({ verdict: "PARTIAL", taskResults: [{ taskId: "t1", verdict: "PASS", notes: "ok" }], outOfScopeChanges: [], notes: "one left" }),
    )
    expect(report.verdict).toBe("PARTIAL")
    expect(report.taskResults[0]).toMatchObject({ taskId: "t1", verdict: "PASS" })
  })

  test("rejects an unknown verdict", () => {
    expect(() => parseValidatorReport(JSON.stringify({ verdict: "MAYBE", taskResults: [] }))).toThrow(/verdict/)
  })
})
