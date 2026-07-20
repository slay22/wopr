import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent"

import { startPermissionGate, type StartGateOptions } from "../src/permissions"
import { noopProgress, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "../src/progress"
import type { ApprovalsConfig } from "../src/types"

type Handler = (event: ToolCallEvent) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void

// Pull the tool_call handler out of the gate's pi extension so we can invoke it
// with a synthetic tool call and assert the block/allow decision directly.
function toolCallHandler(options: StartGateOptions): Handler {
  const gate = startPermissionGate(options)
  const ext = gate.extension
  const factory = typeof ext === "function" ? ext : ext.factory
  let handler: Handler | undefined
  const pi = {
    on: (event: string, h: Handler) => {
      if (event === "tool_call") handler = h
    },
  } as unknown as ExtensionAPI
  factory(pi)
  if (!handler) throw new Error("gate did not register a tool_call handler")
  return handler
}

function bash(command: string): ToolCallEvent {
  return { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: { command } } as ToolCallEvent
}

async function decideBash(command: string, options: Partial<StartGateOptions> = {}) {
  const handler = toolCallHandler({ interactive: true, directory: "/tmp/non-existent-wopr-target", ...options })
  return (await handler(bash(command))) ?? {}
}

const blocked = (result: ToolCallEventResult) => result.block === true

describe("permission gate (tool_call hook)", () => {
  test("denies a hard-denied command regardless of mode", async () => {
    expect(blocked(await decideBash("git push origin main"))).toBe(true)
  })

  test("allows a known-safe command without prompting", async () => {
    const asked: PermissionPromptInfo[] = []
    const progress: ProgressUI = { ...noopProgress, askPermission: async (info) => (asked.push(info), "reject") }
    expect(blocked(await decideBash("git status", { progress }))).toBe(false)
    expect(asked).toHaveLength(0)
  })

  test("non-bash tools are always allowed (read/edit/write gated by tool set)", async () => {
    const handler = toolCallHandler({ interactive: true, directory: "/tmp" })
    const result = (await handler({ type: "tool_call", toolName: "edit", toolCallId: "c", input: {} } as ToolCallEvent)) ?? {}
    expect(blocked(result)).toBe(false)
  })

  test("mode 'all' auto-allows an ask-level command", async () => {
    expect(blocked(await decideBash("./deploy-prod.sh", { autoAccept: { mode: "all" } }))).toBe(false)
  })

  test("interactive prompt: reject blocks, once allows", async () => {
    const reply = (answer: PermissionReply): ProgressUI => ({ ...noopProgress, askPermission: async () => answer })
    expect(blocked(await decideBash("./deploy-prod.sh", { progress: reply("reject") }))).toBe(true)
    expect(blocked(await decideBash("./deploy-prod.sh", { progress: reply("once") }))).toBe(false)
  })

  test("non-interactive run rejects ask-level commands", async () => {
    expect(blocked(await decideBash("./deploy-prod.sh", { interactive: false }))).toBe(true)
  })
})

describe("permission gate with remote approvals", () => {
  const originalFetch = globalThis.fetch
  const originalRandomUUID = crypto.randomUUID
  const approvalsConfig: ApprovalsConfig = {
    topic: { kind: "ntfy", server: "https://ntfy.sh", topic: "wopr-approvals-test" },
    timeoutSeconds: 10,
    onTimeout: "reject",
  }

  beforeEach(() => {
    // Make the gate use a predictable request ID so the mock feed can match it
    crypto.randomUUID = () => "a1b2c3d4-e5f6-7890-abcd-ef1234567890" as `${string}-${string}-${string}-${string}-${string}`
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    crypto.randomUUID = originalRandomUUID
  })

  /** Mocks ntfy so the gate can POST notifications and GET inbox replies.
   * The inbox feed message must include the request ID prefix "a1b2c3d4"
   * since the randomUUID mock is frozen to that value. */
  function mockNtfy(inboxReply: "allow" | "reject" | "always" | "none") {
    const ts = Math.floor(Date.now() / 1000)
    const message = inboxReply === "none" ? "" : `${inboxReply} a1b2c3d4`
    const feed = message ? `{"id":"m1","time":${ts},"event":"message","topic":"wopr-approvals-test","message":"${message}"}` : ""
    globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "POST") return new Response("ok", { status: 200 })
      if (String(url).includes("/json?")) return new Response(feed, { status: 200 })
      return new Response("ok", { status: 200 })
    }) as typeof fetch
  }

  test("non-interactive with approvals configured uses remote resolver (allow)", async () => {
    mockNtfy("allow")
    const handler = toolCallHandler({
      interactive: false,
      directory: "/tmp",
      approvals: approvalsConfig,
      runId: "test-run-remote-1",
      phase: "implement",
      agent: "implementer",
    })
    const result = (await handler(bash("./deploy-prod.sh"))) ?? {}
    // Allow once from remote = not blocked
    expect(blocked(result)).toBe(false)
  }, 15000)

  test("non-interactive with approvals configured: reject blocks", async () => {
    mockNtfy("reject")
    const handler = toolCallHandler({
      interactive: false,
      directory: "/tmp",
      approvals: approvalsConfig,
      runId: "test-run-remote-2",
      phase: "security",
      agent: "security-auditor",
    })
    const result = (await handler(bash("./deploy-prod.sh"))) ?? {}
    expect(blocked(result)).toBe(true)
  }, 15000)

  test("non-interactive without approvals configured rejects normally", async () => {
    const handler = toolCallHandler({
      interactive: false,
      directory: "/tmp",
      // no approvals
    })
    const result = (await handler(bash("./deploy-prod.sh"))) ?? {}
    expect(blocked(result)).toBe(true)
  })

  test("interactive with approvals configured still uses TUI prompt", async () => {
    // When interactive is true, the remote approvals path is skipped.
    // We use noopProgress with askPermission that returns "reject".
    const progress: ProgressUI = { ...noopProgress, askPermission: async () => "reject" as const }
    const handler = toolCallHandler({
      interactive: true,
      directory: "/tmp",
      approvals: approvalsConfig,
      progress,
    })
    const result = (await handler(bash("./deploy-prod.sh"))) ?? {}
    // Should use the TUI prompt (reject via askPermission) → blocked
    expect(blocked(result)).toBe(true)
  })
})
