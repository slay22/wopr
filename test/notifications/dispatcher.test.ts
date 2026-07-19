import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { NotificationDispatcher } from "../../src/notifications/dispatcher"
import type { NotificationEvent, NotificationTarget, NtfyTarget } from "../../src/notifications/types"

describe("NotificationDispatcher", () => {
  let fetchCalls: Array<{ url: string; options: RequestInit }> = []
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    fetchCalls = []
    globalThis.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
      fetchCalls.push({ url: String(url), options: options ?? {} })
      return new Response("ok", { status: 200 })
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const target: NtfyTarget = {
    kind: "ntfy",
    server: "https://ntfy.sh",
    topic: "wopr-test",
  }

  test("empty dispatcher does nothing", () => {
    const dispatcher = new NotificationDispatcher([])
    expect(dispatcher.empty).toBe(true)
    // Should not throw
    dispatcher.fire({ type: "run_started", runId: "test", pipeline: "implement", targetDir: "/tmp" })
    expect(fetchCalls.length).toBe(0)
  })

  test("dispatches to all targets", () => {
    const dispatcher = new NotificationDispatcher([target, { ...target, topic: "wopr-test-2" }])
    expect(dispatcher.empty).toBe(false)
    dispatcher.fire({ type: "run_started", runId: "test", pipeline: "implement", targetDir: "/tmp" })
    // The fire method is fire-and-forget, so we need a small delay
    expect(fetchCalls.length).toBe(2)
  })

  test("test() returns per-target results on success", async () => {
    const dispatcher = new NotificationDispatcher([target])
    const results = await dispatcher.test()
    expect(results.length).toBe(1)
    expect(results[0]!.ok).toBe(true)
    if (results[0]!.ok) {
      expect(results[0]!.target.kind).toBe("ntfy")
      if (results[0]!.target.kind === "ntfy") {
        expect(results[0]!.target.topic).toBe("wopr-test")
      }
    }
  })

  test("test() returns per-target results on failure", async () => {
    globalThis.fetch = async () => { throw new Error("network error") }
    const dispatcher = new NotificationDispatcher([target])
    const results = await dispatcher.test()
    expect(results.length).toBe(1)
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.error).toContain("network error")
  })

  test("run_started event formats correctly", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "run_started",
      runId: "run-123",
      pipeline: "implement",
      targetDir: "/home/user/project",
      worktreePath: "/home/user/.wopr/worktrees/my-feature",
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
  })

  test("phase_failed event fires with high priority", async () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "phase_failed",
      runId: "run-123",
      phase: "implementer",
      attempts: 2,
      error: "something went wrong",
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
    // Priority header should be "high"
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Priority"]).toBe("high")
  })

  test("run_completed event fires", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "run_completed",
      runId: "run-123",
      totalCost: 1.23,
      durationMs: 3600000,
      worktreePath: "/home/user/.wopr/worktrees/my-feature",
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
  })
})
