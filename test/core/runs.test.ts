import { describe, expect, test, beforeEach, afterEach } from "bun:test"

import { RunRegistry } from "../../src/core/_internal"
import {
  startRun,
  cancelRun,
  getRunStatus,
  getRunStatusAsync,
  listRuns,
  listRunsAsync,
  getRunReport,
  getRunCost,
  getRunDiff,
  getRunCommits,
  resumeRun,
} from "../../src/core/runs"
import { RunNotFoundError } from "../../src/core/errors"
import type { RunInput } from "../../src/core/types"

// ─── RunRegistry ──────────────────────────────────────────────────────────

describe("RunRegistry", () => {
  beforeEach(() => {
    RunRegistry.reset()
  })

  test("instance returns a singleton", () => {
    const a = RunRegistry.instance()
    const b = RunRegistry.instance()
    expect(a).toBe(b)
  })

  test("reset creates a fresh singleton", () => {
    const a = RunRegistry.instance()
    RunRegistry.reset()
    const b = RunRegistry.instance()
    expect(a).not.toBe(b)
  })

  test("replace swaps the singleton and returns the previous", () => {
    const orig = RunRegistry.instance()
    const replacement = new RunRegistry()
    const prev = RunRegistry.replace(replacement)
    expect(prev).toBe(orig)
    expect(RunRegistry.instance()).toBe(replacement)
    // Restore for other tests
    RunRegistry.replace(orig)
  })

  test("register and get", () => {
    const registry = RunRegistry.instance()
    const controller = new AbortController()
    const promise = Promise.resolve({ state: "completed" as const, startedAt: 0, finishedAt: 0, totalCost: 0, outcome: "success" as const })
    registry.register({
      runId: "test-1",
      startedAt: 1000,
      status: { state: "starting", startedAt: 1000 },
      abort: () => {},
      promise,
      signal: controller.signal,
    })

    const reg = registry.get("test-1")
    expect(reg).toBeDefined()
    expect(reg!.runId).toBe("test-1")
    expect(reg!.startedAt).toBe(1000)
    expect(reg!.status.state).toBe("starting")
  })

  test("unregister removes a run", () => {
    const registry = RunRegistry.instance()
    const controller = new AbortController()
    const promise = Promise.resolve({ state: "completed" as const, startedAt: 0, finishedAt: 0, totalCost: 0, outcome: "success" as const })
    registry.register({
      runId: "test-2",
      startedAt: 1000,
      status: { state: "starting", startedAt: 1000 },
      abort: () => {},
      promise,
      signal: controller.signal,
    })

    expect(registry.unregister("test-2")).toBe(true)
    expect(registry.get("test-2")).toBeUndefined()
    expect(registry.unregister("test-2")).toBe(false)
  })

  test("size and all reflect registered runs", () => {
    const registry = RunRegistry.instance()
    const controller = new AbortController()
    const promise = Promise.resolve({ state: "completed" as const, startedAt: 0, finishedAt: 0, totalCost: 0, outcome: "success" as const })

    registry.register({ runId: "a", startedAt: 1, status: { state: "starting", startedAt: 1 }, abort: () => {}, promise, signal: controller.signal })
    registry.register({ runId: "b", startedAt: 2, status: { state: "starting", startedAt: 2 }, abort: () => {}, promise, signal: controller.signal })

    expect(registry.size()).toBe(2)
    expect(registry.all().length).toBe(2)
    expect(registry.all().map((r) => r.runId).sort()).toEqual(["a", "b"])
  })

  test("clear removes all runs", () => {
    const registry = RunRegistry.instance()
    const controller = new AbortController()
    const promise = Promise.resolve({ state: "completed" as const, startedAt: 0, finishedAt: 0, totalCost: 0, outcome: "success" as const })

    registry.register({ runId: "a", startedAt: 1, status: { state: "starting", startedAt: 1 }, abort: () => {}, promise, signal: controller.signal })
    registry.clear()
    expect(registry.size()).toBe(0)
  })
})

// ─── startRun ────────────────────────────────────────────────────────────

describe("startRun", () => {
  beforeEach(() => {
    RunRegistry.reset()
  })

  test("returns a handle immediately with runId, promise, and abort", () => {
    const input: RunInput = {
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    }

    const handle = startRun(input)
    expect(handle.runId).toBeTruthy()
    expect(typeof handle.runId).toBe("string")
    expect(handle.promise).toBeInstanceOf(Promise)
    expect(typeof handle.abort).toBe("function")
  })

  test("registers the run in the RunRegistry", () => {
    const input: RunInput = {
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    }

    const handle = startRun(input)
    const registry = RunRegistry.instance()
    const reg = registry.get(handle.runId)
    expect(reg).toBeDefined()
    // The background task may transition to "running" before we check
    expect(["starting", "running"]).toContain(reg!.status.state)
    expect(reg!.startedAt).toBeGreaterThan(0)
  })

  test("abort rejects the running promise", async () => {
    const input: RunInput = {
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    }

    const handle = startRun(input)
    handle.abort("test cancellation")

    // The promise should eventually resolve (not hang)
    const result = await handle.promise
    expect(["aborted", "failed"]).toContain(result.state)
  })
})

// ─── cancelRun ───────────────────────────────────────────────────────────

describe("cancelRun", () => {
  beforeEach(() => {
    RunRegistry.reset()
  })

  test("cancels a registered run", () => {
    const input: RunInput = {
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    }

    const handle = startRun(input)
    const result = cancelRun(handle.runId)
    expect(result.ok).toBe(true)
  })

  test("returns error for unknown run", () => {
    const result = cancelRun("non-existent-run-id")
    if (!result.ok) {
      expect(result.error).toContain("run not found")
    } else {
      // unexpected success — fail the test
      expect.unreachable()
    }
  })
})

// ─── getRunStatus ────────────────────────────────────────────────────────

describe("getRunStatus", () => {
  beforeEach(() => {
    RunRegistry.reset()
  })

  test("returns status for a registered run", () => {
    const input: RunInput = {
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    }

    const handle = startRun(input)
    const status = getRunStatus(handle.runId)
    // The background task may transition to "running" before we check
    expect(["starting", "running"]).toContain(status.state)
    expect(typeof status.startedAt).toBe("number")
  })

  test("throws RunNotFoundError for unknown run with valid run ID", () => {
    // Must use a valid run-ID format (workspace.ts validates the format)
    expect(() => getRunStatus("20240101-000000-aaaa")).toThrow(RunNotFoundError)
  })
})

describe("getRunStatusAsync", () => {
  beforeEach(() => {
    RunRegistry.reset()
  })

  test("returns status for a registered run", async () => {
    const input: RunInput = {
      prompt: "test",
      pipeline: "implement",
      targetDir: "/tmp/test-repo",
    }

    const handle = startRun(input)
    const status = await getRunStatusAsync(handle.runId)
    // The background task may transition to "running" before we check
    expect(["starting", "running"]).toContain(status.state)
  })

  test("throws RunNotFoundError for unknown run with valid run ID", async () => {
    // Must use a valid run-ID format (workspace.ts validates the format)
    await expect(getRunStatusAsync("20240101-000000-aaaa")).rejects.toThrow(RunNotFoundError)
  })
})

// ─── listRuns / listRunsAsync ────────────────────────────────────────────

describe("listRuns", () => {
  test("sync listRuns returns empty array (best-effort)", () => {
    const runs = listRuns()
    expect(Array.isArray(runs)).toBe(true)
    expect(runs.length).toBe(0)
  })
})

describe("listRunsAsync", () => {
  test("returns an array (may be empty in test env)", async () => {
    const runs = await listRunsAsync()
    expect(Array.isArray(runs)).toBe(true)
  })
})

// ─── getRunReport ────────────────────────────────────────────────────────

describe("getRunReport", () => {
  test("rejects path-traversal phase names", async () => {
    await expect(
      getRunReport("20240101-000000-aaaa", "../../../../etc/passwd"),
    ).rejects.toThrow(/invalid phase name/)
  })

  test("rejects empty phase name", async () => {
    await expect(
      getRunReport("20240101-000000-aaaa", ""),
    ).rejects.toThrow(/invalid phase name/)
  })

  test("rejects phase name starting with dot", async () => {
    await expect(
      getRunReport("20240101-000000-aaaa", ".hidden"),
    ).rejects.toThrow(/invalid phase name/)
  })

  test("throws RunNotFoundError for non-existent run", async () => {
    await expect(
      getRunReport("20240101-000000-aaaa", "adversarial"),
    ).rejects.toThrow(RunNotFoundError)
  })
})

// ─── getRunCost ──────────────────────────────────────────────────────────

describe("getRunCost", () => {
  test("throws RunNotFoundError for non-existent run", async () => {
    await expect(getRunCost("20240101-000000-aaaa")).rejects.toThrow(RunNotFoundError)
  })
})

// ─── getRunDiff ──────────────────────────────────────────────────────────

describe("getRunDiff", () => {
  test("returns empty diff for non-existent run directory", async () => {
    // When no run directory exists, getRunDiff falls back to git log
    // in the current directory, which should at least return commitCount
    const diff = await getRunDiff("20240101-000000-aaaa")
    expect(Array.isArray(diff.filesChanged)).toBe(true)
    expect(diff.totalAdditions).toBe(0)
    expect(diff.totalDeletions).toBe(0)
    // commitCount could be 0 or more depending on the test environment
    expect(diff.commitCount).toBeGreaterThanOrEqual(0)
  })
})

// ─── getRunCommits ───────────────────────────────────────────────────────

describe("getRunCommits", () => {
  test("returns empty array for non-existent run directory", async () => {
    // If the runDir doesn't exist, the git log fallback (called with the
    // dir as cwd) will fail, so we get an empty array.
    const commits = await getRunCommits("20240101-000000-aaaa")
    expect(Array.isArray(commits)).toBe(true)
  })
})

// ─── resumeRun ───────────────────────────────────────────────────────────

describe("resumeRun", () => {
  test("throws RunNotFoundError for non-existent run", async () => {
    await expect(resumeRun("20240101-000000-aaaa")).rejects.toThrow(RunNotFoundError)
  })
})
