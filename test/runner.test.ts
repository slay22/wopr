import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RunMetadataStore } from "../src/metadata"
import { noopProgress, type ProgressPhaseSnapshot } from "../src/progress"
import {
  UserAbortError,
  describeSessionActivity,
  newActivityState,
  parseModel,
  restorePhaseFromPreviousRun,
  shouldRetryAttempt,
  shouldSkip,
} from "../src/runner"
import type { AgentStep } from "../src/types"
import type { Workspace } from "../src/workspace"

function messageUpdated(info: Record<string, unknown>) {
  return { type: "message.updated", properties: { sessionID: "ses_1", info } }
}

function assistantInfo(id: string, cost: number, input: number, output: number) {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    cost,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: "openai",
    modelID: "gpt-5.5",
    variant: "xhigh",
  }
}

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
    expect(shouldSkip("security", { onlySteps: ["implementer"], skipSteps: [] })).toBe(true)
    expect(shouldSkip("implementer", { onlySteps: ["implementer"], skipSteps: ["implementer"] })).toBe(false)
    expect(shouldSkip("design", { onlySteps: [], skipSteps: ["design"] })).toBe(true)
    expect(shouldSkip("tests", { onlySteps: [], skipSteps: [] })).toBe(false)
  })

  test("turns assistant message updates into live cumulative usage", () => {
    const state = newActivityState()

    // Creation update carries no usage yet; it must not claim the total.
    expect(describeSessionActivity(messageUpdated(assistantInfo("msg_1", 0, 0, 0)), state)).toBeUndefined()

    const first = describeSessionActivity(messageUpdated(assistantInfo("msg_1", 0.02, 1_000, 200)), state)
    expect(first).toEqual({
      type: "usage",
      usage: {
        cost: 0.02,
        tokens: { input: 1_000, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_200 },
        sessionID: "ses_1",
        model: "openai/gpt-5.5#xhigh",
      },
    })

    // Same totals again: deduplicated so the UI isn't re-rendered for nothing.
    expect(describeSessionActivity(messageUpdated(assistantInfo("msg_1", 0.02, 1_000, 200)), state)).toBeUndefined()

    // A second message accumulates on top of the first.
    const second = describeSessionActivity(messageUpdated(assistantInfo("msg_2", 0.01, 500, 100)), state)
    expect(second?.type).toBe("usage")
    if (second?.type === "usage") {
      expect(second.usage.cost).toBeCloseTo(0.03)
      expect(second.usage.tokens?.input).toBe(1_500)
      expect(second.usage.tokens?.output).toBe(300)
    }

    // User messages never carry usage.
    expect(describeSessionActivity(messageUpdated({ id: "msg_3", role: "user" }), state)).toBeUndefined()
  })

  test("marks provider heartbeats and streaming deltas as feed-exempt pulses", () => {
    const state = newActivityState()

    const busy = describeSessionActivity({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }, state)
    expect(busy).toMatchObject({ type: "activity", message: "provider busy", pulse: true })

    const streaming = describeSessionActivity({ type: "message.part.delta", properties: { sessionID: "ses_1", field: "text" } }, state)
    expect(streaming).toMatchObject({ type: "activity", message: "streaming text", pulse: true })

    const tool = describeSessionActivity({ type: "session.next.tool.called", properties: { sessionID: "ses_1", tool: "bash" } }, state)
    expect(tool).toMatchObject({ type: "activity", message: "bash" })
    expect((tool as { pulse?: boolean }).pulse).toBeUndefined()
  })

  test("restores on resume only when the phase didn't fail", async () => {
    const phase = { name: "design", reportPath: "reports/design.md" } as AgentStep

    const workspaceWith = async (report: boolean) => {
      const dir = await mkdtemp(join(tmpdir(), "archer-resume-"))
      if (report) {
        await mkdir(join(dir, "reports"), { recursive: true })
        await writeFile(join(dir, "reports", "design.md"), "# stale report")
      }
      return { dir, runID: "20260101-000000-test" } as Workspace
    }
    const metadataWith = (snapshot?: ProgressPhaseSnapshot) => ({ snapshot: () => snapshot }) as unknown as RunMetadataStore
    const progressSpy = () => {
      const calls: string[] = []
      return {
        calls,
        progress: {
          ...noopProgress,
          phaseRestored: () => void calls.push("restored"),
          phaseCompleted: () => void calls.push("completed"),
        },
      }
    }

    // No report: nothing to restore.
    const bare = await workspaceWith(false)
    expect(await restorePhaseFromPreviousRun(bare, metadataWith({ status: "completed" }), phase, noopProgress)).toBe(false)

    // Failed phase: retry, and the stale report must be gone.
    const failed = await workspaceWith(true)
    expect(await restorePhaseFromPreviousRun(failed, metadataWith({ status: "failed" }), phase, noopProgress)).toBe(false)
    expect(await Bun.file(join(failed.dir, "reports", "design.md")).exists()).toBe(false)

    // Completed phase: restored with its snapshot.
    const completed = await workspaceWith(true)
    const restoredSpy = progressSpy()
    expect(await restorePhaseFromPreviousRun(completed, metadataWith({ status: "completed" }), phase, restoredSpy.progress)).toBe(true)
    expect(restoredSpy.calls).toEqual(["restored"])

    // Pre-metadata run: the report alone still counts as completed.
    const legacy = await workspaceWith(true)
    const legacySpy = progressSpy()
    expect(await restorePhaseFromPreviousRun(legacy, metadataWith(undefined), phase, legacySpy.progress)).toBe(true)
    expect(legacySpy.calls).toEqual(["completed"])
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
