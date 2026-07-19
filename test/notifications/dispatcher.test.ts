import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { NotificationDispatcher } from "../../src/notifications/dispatcher"
import type { NotificationEvent, NotificationTarget, NtfyTarget } from "../../src/notifications/types"

describe("NotificationDispatcher", () => {
  let fetchCalls: Array<{ url: string; options: RequestInit }> = []
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    fetchCalls = []
    globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
      fetchCalls.push({ url: String(url), options: options ?? {} })
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch
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
    // fire() is fire-and-forget, but the mock fetch pushes synchronously before returning
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
    globalThis.fetch = (async () => { throw new Error("network error") }) as unknown as typeof fetch
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

  test("phase_done event fires with correct headers", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "phase_done",
      runId: "run-123",
      phase: "implementer",
      durationMs: 120000,
      model: "openai/gpt-4",
      tokens: 15000,
      cost: 0.05,
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["X-Tags"]).toBe("white_check_mark,wopr")
    // phase_done uses default priority, so no Priority header
    expect(headers["Priority"]).toBeUndefined()
    const body = fetchCalls[0]!.options.body as string
    expect(body).toContain("implementer done")
    expect(body).toContain("2m")
  })

  test("verdict_received pass event fires with default priority", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "verdict_received",
      runId: "run-123",
      phase: "adversarial",
      verdict: "pass",
      summary: "All checks passed",
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    // PASS verdict uses default priority
    expect(headers["Priority"]).toBeUndefined()
    const body = fetchCalls[0]!.options.body as string
    expect(body).toContain("PASS")
  })

  test("verdict_received reject event fires with high priority", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "verdict_received",
      runId: "run-123",
      phase: "adversarial",
      verdict: "reject",
      summary: "Critical issues found",
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Priority"]).toBe("high")
  })

  test("budget_warning event fires with high priority", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "budget_warning",
      runId: "run-123",
      spent: 8.50,
      cap: 10.00,
      percentUsed: 85,
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Priority"]).toBe("high")
    const body = fetchCalls[0]!.options.body as string
    expect(body).toContain("85%")
  })

  test("budget_exceeded event fires with urgent priority", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "budget_exceeded",
      runId: "run-123",
      spent: 12.00,
      cap: 10.00,
      atPhase: "security",
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Priority"]).toBe("urgent")
    const body = fetchCalls[0]!.options.body as string
    expect(body).toContain("security")
  })

  test("run_failed event fires with urgent priority", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "run_failed",
      runId: "run-123",
      failedPhase: "implementer",
      error: "API rate limit exceeded",
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
    const headers = fetchCalls[0]!.options.headers as Record<string, string>
    expect(headers["Priority"]).toBe("urgent")
    const body = fetchCalls[0]!.options.body as string
    expect(body).toContain("API rate limit exceeded")
  })

  test("run_started event includes worktreePath and estimatedCost", () => {
    const dispatcher = new NotificationDispatcher([target])
    const event: NotificationEvent = {
      type: "run_started",
      runId: "run-123",
      pipeline: "ultra-implement",
      targetDir: "/home/user/project",
      worktreePath: "/home/user/.wopr/worktrees/feature-branch",
      estimatedCost: 5.00,
    }
    dispatcher.fire(event)
    expect(fetchCalls.length).toBe(1)
    const body = fetchCalls[0]!.options.body as string
    expect(body).toContain("ultra-implement")
    expect(body).toContain("feature-branch")
    expect(body).toContain("$5.00")
  })
})
